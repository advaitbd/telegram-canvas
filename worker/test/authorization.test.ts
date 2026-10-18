import { IDENTITY_KEY, ALICE_OWNER, BOB_OWNER, makeSessionCookie } from "./helpers/session-cookie";
/**
 * Viewer endpoint authorization tests.
 *
 * Tests that every viewer endpoint properly rejects unauthenticated
 * and cross-owner requests.  Uses direct handler calls with a test
 * database and cookie fixtures.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "../src/index";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

import { getOwnerFromCookie } from "../src/routes/auth";
import { handleListSessions, handleListArtifacts } from "../src/routes/sessions";
import { handleGetArtifact, handleGetDocument, handleListRevisions, handleExtend, handleTrash } from "../src/routes/artifacts";
import * as Sessions from "../src/db/sessions";
import * as Artifacts from "../src/db/artifacts";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		CANVAS_DB: D1Database;
		CANVAS_ARTIFACTS: R2Bucket;
	}
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

		await Sessions.createSession(db, aliceSessionId, ALICE_OWNER, "hash_alice_s1", "Alice Chat");
		await Sessions.createSession(db, bobSessionId, BOB_OWNER, "hash_bob_s1", "Bob Chat");

		await Artifacts.createArtifact(db, "art_alice_1", aliceSessionId, "Alice Diagram");
		await Artifacts.createArtifact(db, "art_alice_2", aliceSessionId, "Alice Notes");
		await Artifacts.createArtifact(db, "art_bob_1", bobSessionId, "Bob Sketch");

		// Seed some revisions
		await Artifacts.createRevision(db, "rev_alice_1", "art_alice_1", 1, "r2://alice/v1.html", 42, "ready");
		await Artifacts.setCurrentRevision(db, "art_alice_1", "rev_alice_1");
		await r2.put("r2://alice/v1.html", "<h1>Alice</h1>");
		await db.prepare("CREATE TABLE IF NOT EXISTS public_shares (token TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, revision_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()))").run();
		await db.prepare("INSERT INTO public_shares (token, artifact_id, revision_id, expires_at) VALUES (?, ?, ?, ?)")
			.bind("f".repeat(48), "art_alice_1", "rev_alice_1", Math.floor(Date.now() / 1000) + 86400).run();
	});

	it("returns 401 for session listing without cookie", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/sessions");
		const res = await handleListSessions(req, db, IDENTITY_KEY);
		expect(res.status).toBe(401);
	});

	it("returns 401 for artifact listing without cookie", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/sessions/ses_alice_main/artifacts");
		const res = await handleListArtifacts(req, db, "ses_alice_main", IDENTITY_KEY);
		expect(res.status).toBe(401);
	});

	it("lists only Alice's sessions when authenticated as Alice", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/sessions", {
			headers: { Cookie: await makeSessionCookie(ALICE_OWNER) },
		});
		const res = await handleListSessions(req, db, IDENTITY_KEY);
		expect(res.status).toBe(200);
		const body = await res.json() as { sessions: Array<{ id: string }> };
		expect(body.sessions.map((s) => s.id)).toEqual(["ses_alice_main"]);
	});

	it("Alice cannot list Bob's artifacts", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/sessions/ses_bob_main/artifacts", {
			headers: { Cookie: await makeSessionCookie(ALICE_OWNER) },
		});
		const res = await handleListArtifacts(req, db, "ses_bob_main", IDENTITY_KEY);
		expect(res.status).toBe(200);
		const body = await res.json() as { artifacts: unknown[] };
		expect(body.artifacts).toHaveLength(0); // owner mismatch = empty
	});

	it("returns 404 for artifact from another owner", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_bob_1", {
			headers: { Cookie: await makeSessionCookie(ALICE_OWNER) },
		});
		const res = await handleGetArtifact(req, db, "art_bob_1", IDENTITY_KEY);
		expect(res.status).toBe(404);
	});

	it("returns artifact for the owner", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1", {
			headers: { Cookie: await makeSessionCookie(ALICE_OWNER) },
		});
		const res = await handleGetArtifact(req, db, "art_alice_1", IDENTITY_KEY);
		expect(res.status).toBe(200);
		const body = await res.json() as { artifact: { title: string } };
		expect(body.artifact.title).toBe("Alice Diagram");
	});

	it("sandboxes private HTML responses even when opened directly", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1/revisions/rev_alice_1/document", {
			headers: { Cookie: await makeSessionCookie(ALICE_OWNER) },
		});
		const res = await handleGetDocument(req, workerEnv(), "art_alice_1", "rev_alice_1");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toContain("sandbox allow-scripts;");
		expect(res.headers.get("content-security-policy")).not.toContain("allow-same-origin");
		expect(res.headers.get("cache-control")).toBe("private, no-store");
	});

	it("lists revisions for owned artifact", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1/revisions", {
			headers: { Cookie: await makeSessionCookie(ALICE_OWNER) },
		});
		const res = await handleListRevisions(req, db, "art_alice_1", IDENTITY_KEY);
		expect(res.status).toBe(200);
		const body = await res.json() as { revisions: unknown[] };
		expect(body.revisions).toHaveLength(1);
	});

	it("rejects extend without CSRF token", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1/extend", {
			method: "POST",
			headers: { Cookie: await makeSessionCookie(ALICE_OWNER) },
		});
		const res = await handleExtend(req, db, "art_alice_1", IDENTITY_KEY);
		expect(res.status).toBe(403);
	});

	it("rejects extend with wrong Origin", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1/extend", {
			method: "POST",
			headers: {
				Cookie: await makeSessionCookie(ALICE_OWNER),
				Origin: "https://evil.com",
				"Sec-Fetch-Site": "same-origin",
				"X-CSRF-Token": "test",
			},
		});
		const res = await handleExtend(req, db, "art_alice_1", IDENTITY_KEY);
		expect(res.status).toBe(403);
	});

	it("allows extend with valid CSRF", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1/extend", {
			method: "POST",
			headers: {
				Cookie: await makeSessionCookie(ALICE_OWNER),
				Origin: "https://canvas.advaitdeshpande.com",
				"Sec-Fetch-Site": "same-origin",
				"X-CSRF-Token": "valid-csrf-token",
			},
		});
		const res = await handleExtend(req, db, "art_alice_1", IDENTITY_KEY);
		expect(res.status).toBe(200);
	});

	it("rejects trash without CSRF", async () => {
		const req = new Request("https://canvas.advaitdeshpande.com/api/artifacts/art_alice_1", {
			method: "DELETE",
			headers: { Cookie: await makeSessionCookie(ALICE_OWNER) },
		});
		const res = await handleTrash(req, db, "art_alice_1", IDENTITY_KEY);
		expect(res.status).toBe(403);
	});

	it("allows trash with valid CSRF", async () => {
		const artId = "art_trash_test_" + crypto.randomUUID();
		await Artifacts.createArtifact(db, artId, "ses_alice_main", "To Trash");

		const req = new Request(`https://canvas.advaitdeshpande.com/api/artifacts/${artId}`, {
			method: "DELETE",
			headers: {
				Cookie: await makeSessionCookie(ALICE_OWNER),
				Origin: "https://canvas.advaitdeshpande.com",
				"Sec-Fetch-Site": "same-origin",
				"X-CSRF-Token": "valid-csrf-token",
			},
		});
		const res = await handleTrash(req, db, artId, IDENTITY_KEY);
		expect(res.status).toBe(200);
		const body = await res.json() as { trashed: boolean };
		expect(body.trashed).toBe(true);
	});

	const protectedEndpoints = [
		["GET", "/api/bootstrap"], ["GET", "/api/sessions"], ["GET", "/api/canvases"],
		["GET", "/api/sessions/ses_alice_main/artifacts"],
		["GET", "/api/artifacts/art_alice_1"], ["GET", "/api/artifacts/art_alice_1/revisions"],
		["GET", "/api/artifacts/art_alice_1/revisions/rev_alice_1/document"],
		["GET", "/api/artifacts/art_alice_1/download"],
		["POST", "/api/artifacts/art_alice_1/extend"], ["DELETE", "/api/artifacts/art_alice_1"],
		["GET", "/api/artifacts/art_alice_1/shares"], ["POST", "/api/artifacts/art_alice_1/shares"],
		["DELETE", `/api/artifacts/art_alice_1/shares/${"f".repeat(48)}`],
		["GET", "/api/stream/ses_alice_main"],
	];
	const workerEnv = () => ({ CANVAS_DB: db, CANVAS_ARTIFACTS: r2, IDENTITY_HMAC_KEY: IDENTITY_KEY } as Env);
	const routeRequest = (method: string, path: string, cookie: string) => new Request(`https://canvas.advaitdeshpande.com${path}`, {
		method, headers: { Cookie: cookie, Origin: "https://canvas.advaitdeshpande.com", "Sec-Fetch-Site": "same-origin", "X-CSRF-Token": "synthetic-csrf" },
	});

	it.each(protectedEndpoints)("%s %s rejects unsigned, tampered, malformed, and expired cookies before accessing resources", async (method, path) => {
		const signed = await makeSessionCookie(ALICE_OWNER);
		const cookies = [
			`__Host-canvas_session=legacy.${ALICE_OWNER}`,
			signed.replace(ALICE_OWNER, BOB_OWNER),
			signed.slice(0, -1) + "z",
			await makeSessionCookie(ALICE_OWNER, Math.floor(Date.now() / 1000) - 1),
		];
		for (const cookie of cookies) {
			const response = await worker.fetch(routeRequest(method, path, cookie), workerEnv(), createExecutionContext());
			expect(response.status).toBe(401);
		}
	});

	it("keeps signed owners isolated through dispatch for bootstrap, archive, documents, downloads, mutations, shares, and stream", async () => {
		const alice = await makeSessionCookie(ALICE_OWNER);
		const bob = await makeSessionCookie(BOB_OWNER);
		for (const path of ["/api/bootstrap", "/api/canvases", "/api/sessions"]) {
			const response = await worker.fetch(routeRequest("GET", path, alice), workerEnv(), createExecutionContext());
			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body).toContain(path === "/api/sessions" ? "ses_alice_main" : "art_alice_1");
			expect(body).not.toContain("bob");
		}
		for (const path of ["/api/artifacts/art_alice_1/revisions/rev_alice_1/document", "/api/artifacts/art_alice_1/download"]) {
			const owned = await worker.fetch(routeRequest("GET", path, alice), workerEnv(), createExecutionContext());
			expect(owned.status).toBe(200);
			expect(await owned.text()).toContain("Alice");
		}
		for (const [method, path] of protectedEndpoints.slice(4)) {
			const response = await worker.fetch(routeRequest(method, path, bob), workerEnv(), createExecutionContext());
			expect(response.status).toBe(404);
		}
		expect((await Artifacts.getArtifact(db, "art_alice_1", ALICE_OWNER))?.trashed_at).toBeNull();
		expect(await db.prepare("SELECT token FROM public_shares WHERE token = ?").bind("f".repeat(48)).first()).not.toBeNull();
	});

	it("dispatches signed owner share requests and forwards only an owned stream", async () => {
		const alice = await makeSessionCookie(ALICE_OWNER);
		for (const method of ["GET", "POST"]) {
			const response = await worker.fetch(routeRequest(method, "/api/artifacts/art_alice_1/shares", alice), workerEnv(), createExecutionContext());
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("f".repeat(48));
		}
		const revoked = await worker.fetch(routeRequest("DELETE", `/api/artifacts/art_alice_1/shares/${"f".repeat(48)}`, alice), workerEnv(), createExecutionContext());
		expect(revoked.status).toBe(200);
		let forwarded = 0;
		const streamEnv = { ...workerEnv(), ARTIFACT_ROOM: {
			idFromName(name: string) { expect(name).toBe("session:ses_alice_main"); return "synthetic-room"; },
			get(id: string) { expect(id).toBe("synthetic-room"); return { fetch() { forwarded++; return new Response("synthetic stream forwarding"); } }; },
		} } as unknown as Env;
		const owned = await worker.fetch(routeRequest("GET", "/api/stream/ses_alice_main", alice), streamEnv, createExecutionContext());
		expect(owned.status).toBe(200);
		expect(forwarded).toBe(1);
		const other = await worker.fetch(routeRequest("GET", "/api/stream/ses_alice_main", await makeSessionCookie(BOB_OWNER)), streamEnv, createExecutionContext());
		expect(other.status).toBe(404);
		expect(forwarded).toBe(1);
	});

	it("getOwnerFromCookie verifies owner hash", async () => {
		const req = new Request("https://example.com", {
			headers: { Cookie: await makeSessionCookie(ALICE_OWNER) },
		});
		expect(await getOwnerFromCookie(req, IDENTITY_KEY)).toBe(ALICE_OWNER);
	});

	it("getOwnerFromCookie returns null for missing cookie", async () => {
		const req = new Request("https://example.com");
		expect(await getOwnerFromCookie(req, IDENTITY_KEY)).toBeNull();
	});
});
