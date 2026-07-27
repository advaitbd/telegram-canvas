/**
 * Viewer endpoint authorization tests.
 *
 * Tests that every viewer endpoint properly rejects unauthenticated
 * and cross-owner requests.  Uses direct handler calls with a test
 * database and cookie fixtures.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

import { handleTelegramAuth, getOwnerFromCookie } from "../src/routes/auth";
import { handleListSessions, handleListArtifacts } from "../src/routes/sessions";
import { handleGetArtifact, handleListRevisions, handleExtend, handleTrash } from "../src/routes/artifacts";
import * as Sessions from "../src/db/sessions";
import * as Artifacts from "../src/db/artifacts";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		CANVAS_DB: D1Database;
		CANVAS_ARTIFACTS: R2Bucket;
	}
}

/** A valid shell session cookie value for a known owner. */
function makeSessionCookie(ownerHash: string): string {
	const sid = crypto.randomUUID();
	return `__Host-canvas_session=${sid}.${ownerHash.slice(0, 16)}`;
}

describe("Viewer authorization", () => {
	let db: D1Database;
	let r2: R2Bucket;

	beforeAll(async () => {
		db = env.CANVAS_DB;
		r2 = env.CANVAS_ARTIFACTS;

		// Schema
		await db.prepare(`CREATE TABLE IF NOT EXISTS session_records (
			id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, session_hash TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '',
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
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`).run();
		await db.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_owner_lookup ON artifacts(id, session_id)").run().catch(() => {});
		await db.prepare(`CREATE TABLE IF NOT EXISTS artifact_revisions (
			id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
			ordinal INTEGER NOT NULL, r2_key TEXT NOT NULL, content_bytes INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`).run();

		// Create test data: Alice has a session with artifacts; Bob has a separate session
		const aliceSessionId = "ses_alice_main";
		const bobSessionId = "ses_bob_main";

		await Sessions.createSession(db, aliceSessionId, "owner_alice", "hash_alice_s1", "Alice Chat");
		await Sessions.createSession(db, bobSessionId, "owner_bob", "hash_bob_s1", "Bob Chat");

		await Artifacts.createArtifact(db, "art_alice_1", aliceSessionId, "Alice Diagram");
		await Artifacts.createArtifact(db, "art_alice_2", aliceSessionId, "Alice Notes");
		await Artifacts.createArtifact(db, "art_bob_1", bobSessionId, "Bob Sketch");

		// Seed some revisions
		await Artifacts.createRevision(db, "rev_alice_1", "art_alice_1", 1, "r2://alice/v1.html", 42, "ready");
		await Artifacts.setCurrentRevision(db, "art_alice_1", "rev_alice_1");
	});

	it("returns 401 for session listing without cookie", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/sessions");
		const res = await handleListSessions(req, db);
		expect(res.status).toBe(401);
	});

	it("returns 401 for artifact listing without cookie", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/sessions/ses_alice_main/artifacts");
		const res = await handleListArtifacts(req, db, "ses_alice_main");
		expect(res.status).toBe(401);
	});

	it("lists only Alice's sessions when authenticated as Alice", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/sessions", {
			headers: { Cookie: makeSessionCookie("owner_alice") },
		});
		const res = await handleListSessions(req, db);
		expect(res.status).toBe(200);
		const body = await res.json() as { sessions: Array<{ id: string }> };
		expect(body.sessions.every((s) => s.id.startsWith("ses_alice"))).toBe(true);
	});

	it("Alice cannot list Bob's artifacts", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/sessions/ses_bob_main/artifacts", {
			headers: { Cookie: makeSessionCookie("owner_alice") },
		});
		const res = await handleListArtifacts(req, db, "ses_bob_main");
		expect(res.status).toBe(200);
		const body = await res.json() as { artifacts: unknown[] };
		expect(body.artifacts).toHaveLength(0); // owner mismatch = empty
	});

	it("returns 404 for artifact from another owner", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_bob_1", {
			headers: { Cookie: makeSessionCookie("owner_alice") },
		});
		const res = await handleGetArtifact(req, db, "art_bob_1");
		expect(res.status).toBe(404);
	});

	it("returns artifact for the owner", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1", {
			headers: { Cookie: makeSessionCookie("owner_alice") },
		});
		const res = await handleGetArtifact(req, db, "art_alice_1");
		expect(res.status).toBe(200);
		const body = await res.json() as { artifact: { title: string } };
		expect(body.artifact.title).toBe("Alice Diagram");
	});

	it("lists revisions for owned artifact", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1/revisions", {
			headers: { Cookie: makeSessionCookie("owner_alice") },
		});
		const res = await handleListRevisions(req, db, "art_alice_1");
		expect(res.status).toBe(200);
		const body = await res.json() as { revisions: unknown[] };
		expect(body.revisions).toHaveLength(1);
	});

	it("rejects extend without CSRF token", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1/extend", {
			method: "POST",
			headers: { Cookie: makeSessionCookie("owner_alice") },
		});
		const res = await handleExtend(req, db, "art_alice_1");
		expect(res.status).toBe(403);
	});

	it("rejects extend with wrong Origin", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1/extend", {
			method: "POST",
			headers: {
				Cookie: makeSessionCookie("owner_alice"),
				Origin: "https://evil.com",
				"Sec-Fetch-Site": "same-origin",
				"X-CSRF-Token": "test",
			},
		});
		const res = await handleExtend(req, db, "art_alice_1");
		expect(res.status).toBe(403);
	});

	it("allows extend with valid CSRF", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1/extend", {
			method: "POST",
			headers: {
				Cookie: makeSessionCookie("owner_alice"),
				Origin: "https://canvas.advaitdeshpande.com",
				"Sec-Fetch-Site": "same-origin",
				"X-CSRF-Token": "valid-csrf-token",
			},
		});
		const res = await handleExtend(req, db, "art_alice_1");
		expect(res.status).toBe(200);
	});

	it("rejects trash without CSRF", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1", {
			method: "DELETE",
			headers: { Cookie: makeSessionCookie("owner_alice") },
		});
		const res = await handleTrash(req, db, "art_alice_1");
		expect(res.status).toBe(403);
	});

	it("allows trash with valid CSRF", async () => {
		const artId = "art_trash_test_" + crypto.randomUUID();
		await Artifacts.createArtifact(db, artId, "ses_alice_main", "To Trash");

		const req = new Request(`https://canvas.advaitdeshpande.com/api/artifacts/${artId}`, {
			method: "DELETE",
			headers: {
				Cookie: makeSessionCookie("owner_alice"),
				Origin: "https://canvas.advaitdeshpande.com",
				"Sec-Fetch-Site": "same-origin",
				"X-CSRF-Token": "valid-csrf-token",
			},
		});
		const res = await handleTrash(req, db, artId);
		expect(res.status).toBe(200);
		const body = await res.json() as { trashed: boolean };
		expect(body.trashed).toBe(true);
	});

	it("getOwnerFromCookie parses owner hash", () => {
		const req = new Request("https://example.com", {
			headers: { Cookie: `__Host-canvas_session=sid123.owner_abcd` },
		});
		expect(getOwnerFromCookie(req)).toBe("owner_abcd");
	});

	it("getOwnerFromCookie returns null for missing cookie", () => {
		const req = new Request("https://example.com");
		expect(getOwnerFromCookie(req)).toBeNull();
	});
});
