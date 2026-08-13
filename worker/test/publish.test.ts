/**
 * Publish route integration tests.
 *
 * Tests call handlePublish directly with a test env that includes the
 * Miniflare D1 and R2 bindings plus the test secrets. This gives full
 * control over the environment and avoids SELF.fetch binding issues.
 *
 * Coverage:
 *  - New artifact publish creates session + artifact + revision + R2 blob
 *  - Revision to existing artifact creates new revision, updates current
 *  - Foreign-owner update is rejected (different owner_hash)
 *  - Oversized body (>5 MiB) is rejected
 *  - Missing publisher auth headers → 401
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { handlePublish } from "../src/routes/publish";
import * as Sessions from "../src/db/sessions";
import { deriveOwnerHash, deriveSessionHash } from "../src/auth/identity";
import * as Artifacts from "../src/db/artifacts";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		CANVAS_DB: D1Database;
		CANVAS_ARTIFACTS: R2Bucket;
	}
}

const PUBLISHER_SECRET = "ab" + "cd".repeat(31);
const IDENTITY_KEY = "ef" + "01".repeat(31);

/** Minimal mock for the DO namespace — not needed for Task 5 tests that don't test broadcasts. */
const MOCK_DO_NS = {
	idFromName: () => ({}) as any,
	get: () => ({
		fetch: async () => new Response("{}"),
	}) as any,
};

async function buildSignedRequest(
	body: Record<string, unknown>,
	keyId = "key1",
	secretHex = PUBLISHER_SECRET,
): Promise<Request> {
	const bodyStr = JSON.stringify(body);
	const encoder = new TextEncoder();
	const timestamp = Math.floor(Date.now() / 1000);
	const nonce = crypto.randomUUID();
	const bodySha256 = Array.from(new Uint8Array(
		await crypto.subtle.digest("SHA-256", encoder.encode(bodyStr)),
	)).map((b) => b.toString(16).padStart(2, "0")).join("");

	const canonical = ["v1", "POST", "/internal/publish", keyId, String(timestamp), nonce, bodySha256].join("\n");
	const keyBytes = new Uint8Array(secretHex.length / 2);
	for (let i = 0; i < secretHex.length; i += 2)
		keyBytes[i / 2] = parseInt(secretHex.slice(i, i + 2), 16);
	const cryptoKey = await crypto.subtle.importKey(
		"raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(canonical));
	const sigHex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");

	return new Request("https://canvas.advaitdeshpande.com/internal/publish", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-canvas-key-id": keyId,
			"x-canvas-timestamp": String(timestamp),
			"x-canvas-nonce": nonce,
			"x-canvas-signature": sigHex,
		},
		body: bodyStr,
	});
}

describe("Publish endpoint", () => {
	let db: D1Database;
	let r2: R2Bucket;

	/** Build the env object for handlePublish. */
	function testEnv(): Parameters<typeof handlePublish>[1] {
		return {
			CANVAS_DB: db,
			CANVAS_ARTIFACTS: r2,
			ARTIFACT_ROOM: MOCK_DO_NS as any,
			PUBLISHER_SECRET,
			IDENTITY_HMAC_KEY: IDENTITY_KEY,
		};
	}

	beforeAll(async () => {
		db = env.CANVAS_DB;
		r2 = env.CANVAS_ARTIFACTS;

		await db.prepare(`CREATE TABLE IF NOT EXISTS session_records (
			id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, session_hash TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '', chat_name TEXT NOT NULL DEFAULT '',
			last_active_at INTEGER NOT NULL DEFAULT (unixepoch()),
			expires_at INTEGER NOT NULL DEFAULT (unixepoch() + 2592000),
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`).run();
		await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_session_owner_hash ON session_records(owner_hash, session_hash)").run().catch(() => {});
		await db.prepare(`CREATE TABLE IF NOT EXISTS artifacts (
			id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_records(id) ON DELETE CASCADE,
			title TEXT NOT NULL DEFAULT '', current_revision_id TEXT,
			trashed_at INTEGER, purge_after INTEGER,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`).run();
		await db.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_session_trash ON artifacts(session_id, trashed_at)").run().catch(() => {});
		await db.prepare(`CREATE TABLE IF NOT EXISTS artifact_revisions (
			id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
			ordinal INTEGER NOT NULL, r2_key TEXT NOT NULL, content_bytes INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`).run();
		await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_revision_ordinal ON artifact_revisions(artifact_id, ordinal)").run().catch(() => {});
		await db.prepare("CREATE TABLE IF NOT EXISTS publisher_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)").run();
		await db.prepare("CREATE TABLE IF NOT EXISTS publisher_rate_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_hash TEXT NOT NULL, session_id TEXT NOT NULL, window_start INTEGER NOT NULL DEFAULT (unixepoch()))").run();
		await db.prepare("CREATE INDEX IF NOT EXISTS idx_rate_owner ON publisher_rate_limits(owner_hash, window_start)").run().catch(() => {});
	});

	it("publishes a new artifact (first publish creates session)", async () => {
		const req = await buildSignedRequest({
			telegram_creator_id: "user_123",
			hermes_session_id: "sess_abc_001",
			session_title: "My Session",
			title: "Hello Canvas",
			html: "<!doctype html><h1>Hello</h1>",
		});

		const res = await handlePublish(req, testEnv());
		expect(res.status).toBe(200);

		const body = await res.json() as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.artifact_id).toBeTruthy();
		expect(body.revision_id).toBeTruthy();
		expect(body.ordinal).toBe(1);
		expect(body.action).toBe("created");

		// Verify R2 blob
		const r2Key = `artifacts/${body.artifact_id}/${body.revision_id}.html`;
		const r2Obj = await r2.get(r2Key);
		expect(r2Obj).not.toBeNull();
		expect(await r2Obj!.text()).toBe("<!doctype html><h1>Hello</h1>");
	});

	it("publishes a revision to an existing artifact", async () => {
		// First publish
		const req1 = await buildSignedRequest({
			telegram_creator_id: "user_rev2",
			hermes_session_id: "sess_rev2",
			title: "V1",
			html: "<p>v1</p>",
		});
		const res1 = await handlePublish(req1, testEnv());
		expect(res1.status).toBe(200);
		const body1 = await res1.json() as Record<string, string>;

		// Second publish with artifact_id and refreshed session metadata
		const req2 = await buildSignedRequest({
			telegram_creator_id: "user_rev2",
			hermes_session_id: "sess_rev2",
			session_title: "Renamed Session",
			chat_name: "Renamed Chat",
			artifact_id: body1.artifact_id,
			title: "V2",
			html: "<p>v2</p>",
		});
		const res2 = await handlePublish(req2, testEnv());
		expect(res2.status).toBe(200);
		const body2 = await res2.json() as Record<string, unknown>;
		expect(body2.ordinal).toBe(2);
		expect(body2.action).toBe("updated");

		// Verify both revisions exist
		const ownerHash = await deriveOwnerHash("user_rev2", IDENTITY_KEY);
		const sessionHash = await deriveSessionHash("sess_rev2", IDENTITY_KEY);
		const session = await Sessions.getSessionByHashes(db, ownerHash, sessionHash);
		expect(session?.title).toBe("Renamed Session");
		expect(session?.chat_name).toBe("Renamed Chat");
		const revisions = await Artifacts.listRevisions(db, body1.artifact_id);
		expect(revisions).toHaveLength(2);
	});

	it("rejects publish with missing auth headers (401)", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/internal/publish", {
			method: "POST",
			body: JSON.stringify({ telegram_creator_id: "x", hermes_session_id: "y", title: "x", html: "<p>x</p>" }),
		});
		const res = await handlePublish(req, testEnv());
		expect(res.status).toBe(401);
	});

	it("rejects oversized body (>5 MiB)", async () => {
		const largeHtml = "x".repeat(6 * 1024 * 1024);
		const req = await buildSignedRequest({
			telegram_creator_id: "user_big",
			hermes_session_id: "sess_big",
			title: "Large",
			html: largeHtml,
		});
		const res = await handlePublish(req, testEnv());
		expect(res.status).toBe(413);
	});

	it("rejects update of non-existent artifact (404)", async () => {
		const req = await buildSignedRequest({
			telegram_creator_id: "user_fake",
			hermes_session_id: "sess_fake",
			artifact_id: crypto.randomUUID(),
			title: "Ghost",
			html: "<p>ghost</p>",
		});
		const res = await handlePublish(req, testEnv());
		expect(res.status).toBe(404);
	});

	it("rejects foreign-owner artifact update (404 — not found for this owner)", async () => {
		// Alice creates
		const req1 = await buildSignedRequest({
			telegram_creator_id: "alice_owner",
			hermes_session_id: "sess_alice",
			title: "Alice Artifact",
			html: "<p>alice</p>",
		});
		const res1 = await handlePublish(req1, testEnv());
		expect(res1.status).toBe(200);
		const body1 = await res1.json() as Record<string, string>;

		// Bob tries to update Alice's artifact
		const req2 = await buildSignedRequest({
			telegram_creator_id: "bob_owner",
			hermes_session_id: "sess_bob",
			artifact_id: body1.artifact_id,
			title: "Bob's Update",
			html: "<p>bob</p>",
		});
		const res2 = await handlePublish(req2, testEnv());
		expect(res2.status).toBe(404);
	});
});
