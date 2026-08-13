import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { handleCreateShare, handleListShares, handlePublicDocument, handlePublicShare, handleRevokeShare } from "../src/routes/shares";
import * as Artifacts from "../src/db/artifacts";
import * as Sessions from "../src/db/sessions";

const origin = "https://canvas.advaitdeshpande.com";
const cookie = "__Host-canvas_session=test.owner_alice";

function ownerRequest(path: string, method = "GET", body?: unknown): Request {
	return new Request(`${origin}${path}`, {
		method,
		headers: {
			Cookie: cookie,
			Origin: origin,
			"Sec-Fetch-Site": "same-origin",
			"X-CSRF-Token": "csrf",
			...(body ? { "content-type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

describe("public shares", () => {
	let db: D1Database;
	let r2: R2Bucket;
	const artifactId = "art_public_share";

	beforeAll(async () => {
		db = env.CANVAS_DB;
		r2 = env.CANVAS_ARTIFACTS;
		await db.prepare("CREATE TABLE IF NOT EXISTS session_records (id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, session_hash TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', chat_name TEXT NOT NULL DEFAULT '', last_active_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
		await db.prepare("CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', current_revision_id TEXT, trashed_at INTEGER, purge_after INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
		await db.prepare("CREATE TABLE IF NOT EXISTS artifact_revisions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, ordinal INTEGER NOT NULL, r2_key TEXT NOT NULL, content_bytes INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)").run();
		await db.prepare("CREATE TABLE IF NOT EXISTS public_shares (token TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, revision_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()))").run();
		await Sessions.createSession(db, "ses_public_share", "owner_alice", "hash_public_share", "Public share");
		await Artifacts.createArtifact(db, artifactId, "ses_public_share", "Share me");
		await Artifacts.createRevision(db, "rev_public_share", artifactId, 1, "public/share.html", 20, "ready");
		await Artifacts.setCurrentRevision(db, artifactId, "rev_public_share");
		await r2.put("public/share.html", "<h1>safe share</h1>");
	});

	it("creates a 30-day share link pinned to the current revision", async () => {
		const res = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 2592000 }), db, artifactId);
		expect(res.status).toBe(201);
		const body = await res.json() as { token: string; revision_id: string; url: string; expires_at: number };
		expect(body.token).toMatch(/^[a-f0-9]{48}$/);
		expect(body.revision_id).toBe("rev_public_share");
		expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 86400);
	});

	it("reuses an active share only while pinned to the current ready revision", async () => {
		const first = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const firstBody = await first.json() as { token: string; revision_id: string; expires_at: number };
		const retry = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 2592000 }), db, artifactId);
		const retryBody = await retry.json() as { token: string; revision_id: string; expires_at: number };
		expect(retry.status).toBe(200);
		expect(retryBody).toEqual(firstBody);

		await Artifacts.createRevision(db, "rev_public_share_2", artifactId, 2, "public/share-2.html", 22, "ready");
		await Artifacts.setCurrentRevision(db, artifactId, "rev_public_share_2");
		await r2.put("public/share-2.html", "<h1>safe share</h1>");
		const next = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const nextBody = await next.json() as { token: string; revision_id: string; expires_at: number };
		expect(next.status).toBe(201);
		expect(nextBody.token).not.toBe(firstBody.token);
		expect(nextBody.revision_id).toBe("rev_public_share_2");
	});

	it("serves a share inside a sandboxed viewer, and its document without cookies", async () => {
		const create = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const { token } = await create.json() as { token: string };
		const viewer = await handlePublicShare(new Request(`${origin}/s/${token}`), db, token);
		expect(viewer.status).toBe(200);
		expect(await viewer.text()).toContain('sandbox="allow-scripts"');
		const document = await handlePublicDocument(db, r2, token);
		expect(await document.text()).toContain("safe share");
		expect(document.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
	});

	it("lists an owner's active public links without exposing expired ones", async () => {
		const active = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const { token } = await active.json() as { token: string };
		await db.prepare("INSERT INTO public_shares (token, artifact_id, revision_id, expires_at) VALUES (?, ?, ?, ?)")
			.bind("f".repeat(48), artifactId, "rev_public_share", Math.floor(Date.now() / 1000) - 1).run();
		const res = await handleListShares(ownerRequest(`/api/artifacts/${artifactId}/shares`), db, artifactId);
		expect(res.status).toBe(200);
		const body = await res.json() as { shares: Array<{ token: string; revision_id: string; url: string }> };
		expect(body.shares.some((share) => share.token === token && share.url === `${origin}/s/${token}`)).toBe(true);
		expect(body.shares.some((share) => share.token === "f".repeat(48))).toBe(false);
	});

	it("rejects invalid durations and revokes shares immediately", async () => {
		const invalid = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 60 }), db, artifactId);
		expect(invalid.status).toBe(400);
		const create = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const { token } = await create.json() as { token: string };
		const revoked = await handleRevokeShare(ownerRequest(`/api/artifacts/${artifactId}/shares/${token}`, "DELETE"), db, artifactId, token);
		expect(revoked.status).toBe(200);
		expect((await handlePublicShare(new Request(`${origin}/s/${token}`), db, token)).status).toBe(404);
	});
});
