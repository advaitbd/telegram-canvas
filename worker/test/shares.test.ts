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
		// New schema shape: revision_id is plain metadata, no FK to revisions.
		await db.prepare("CREATE TABLE IF NOT EXISTS public_shares (token TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, revision_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()))").run();
		await Sessions.createSession(db, "ses_public_share", "owner_alice", "hash_public_share", "Public share");
		await Artifacts.createArtifact(db, artifactId, "ses_public_share", "Share me");
		await Artifacts.createRevision(db, "rev_public_share", artifactId, 1, "public/share.html", 20, "ready");
		await Artifacts.setCurrentRevision(db, artifactId, "rev_public_share");
		await r2.put("public/share.html", "<h1>safe share</h1>");
	});

	it("creates a 30-day live link to the current ready revision", async () => {
		const res = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 2592000 }), db, artifactId);
		expect(res.status).toBe(201);
		const body = await res.json() as { token: string; revision_id: string; url: string; expires_at: number };
		expect(body.token).toMatch(/^[a-f0-9]{48}$/);
		expect(body.revision_id).toBe("rev_public_share");
		expect(body.url).toBe(`${origin}/s/${body.token}`);
		expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 86400);
		// No phantom tokens: the returned link must actually resolve.
		expect((await handlePublicShare(new Request(`${origin}/s/${body.token}`), db, body.token)).status).toBe(200);
	});

	it("reuses one link across revisions and serves the latest ready revision", async () => {
		const first = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const firstBody = await first.json() as { token: string };
		expect(first.status).toBe(201);

		// A new revision becomes current: the same link must keep working.
		await Artifacts.createRevision(db, "rev_public_share_2", artifactId, 2, "public/share-2.html", 22, "ready");
		await Artifacts.setCurrentRevision(db, artifactId, "rev_public_share_2");
		await r2.put("public/share-2.html", "<h1>latest ready</h1>");

		const retry = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 2592000 }), db, artifactId);
		const retryBody = await retry.json() as { token: string; revision_id: string };
		expect(retry.status).toBe(200);
		expect(retryBody.token).toBe(firstBody.token);
		expect(retryBody.revision_id).toBe("rev_public_share_2");

		const document = await handlePublicDocument(db, r2, retryBody.token);
		expect(document.status).toBe(200);
		expect(await document.text()).toContain("latest ready");
	});

	it("creates exactly one link under concurrent requests", async () => {
		const responses = await Promise.all(
			Array.from({ length: 8 }, () => handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId)),
		);
		const bodies = await Promise.all(responses.map((res) => res.json() as Promise<{ token: string }>));
		expect(new Set(bodies.map((body) => body.token)).size).toBe(1);
		expect(responses.filter((res) => res.status === 201)).toHaveLength(1);
	});

	it("never serves a failed revision as the latest", async () => {
		const create = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const { token } = await create.json() as { token: string };
		await Artifacts.createRevision(db, "rev_public_failed", artifactId, 2, "public/failed.html", 5, "failed");
		await r2.put("public/failed.html", "<h1>bad revision</h1>");
		await Artifacts.setCurrentRevision(db, artifactId, "rev_public_failed");
		const document = await handlePublicDocument(db, r2, token);
		expect(document.status).toBe(200);
		expect(await document.text()).toContain("safe share");
	});

	it("serves the newest ready revision even when the current pointer is stale", async () => {
		// rev2 is ready but the artifact's current_revision_id still points at rev1.
		await Artifacts.createRevision(db, "rev_stale_new", artifactId, 2, "public/stale-new.html", 5, "ready");
		await r2.put("public/stale-new.html", "<h1>newest ready</h1>");
		const create = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const { token } = await create.json() as { token: string };
		const document = await handlePublicDocument(db, r2, token);
		expect(document.status).toBe(200);
		expect(await document.text()).toContain("newest ready");
	});

	it("does not leak another artifact's revision into a link", async () => {
		await Artifacts.createArtifact(db, "art_other", "ses_public_share", "Other canvas");
		await Artifacts.createRevision(db, "rev_other", "art_other", 9, "public/other.html", 5, "ready");
		await Artifacts.setCurrentRevision(db, "art_other", "rev_other");
		await r2.put("public/other.html", "<h1>other canvas</h1>");
		const create = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const { token } = await create.json() as { token: string };
		const document = await handlePublicDocument(db, r2, token);
		const html = await document.text();
		expect(html).toContain("safe share");
		expect(html).not.toContain("other canvas");
	});

	it("stops rendering when the artifact is trashed or deleted", async () => {
		const create = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const { token } = await create.json() as { token: string };
		await db.prepare("UPDATE artifacts SET trashed_at = unixepoch() WHERE id = ?").bind(artifactId).run();
		expect((await handlePublicShare(new Request(`${origin}/s/${token}`), db, token)).status).toBe(404);
		await db.prepare("UPDATE artifacts SET trashed_at = NULL WHERE id = ?").bind(artifactId).run();
		await db.prepare("DELETE FROM artifacts WHERE id = ?").bind(artifactId).run();
		expect((await handlePublicDocument(db, r2, token)).status).toBe(404);
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

	it("lists active links with the live revision id, excluding expired ones", async () => {
		const active = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const { token } = await active.json() as { token: string };
		await db.prepare("INSERT INTO public_shares (token, artifact_id, revision_id, expires_at) VALUES (?, ?, ?, ?)")
			.bind("f".repeat(48), artifactId, "rev_public_share", Math.floor(Date.now() / 1000) - 1).run();
		const res = await handleListShares(ownerRequest(`/api/artifacts/${artifactId}/shares`), db, artifactId);
		expect(res.status).toBe(200);
		const body = await res.json() as { shares: Array<{ token: string; revision_id: string; url: string }> };
		expect(body.shares).toHaveLength(1);
		expect(body.shares[0]).toMatchObject({ token, revision_id: "rev_public_share", url: `${origin}/s/${token}` });

		await Artifacts.createRevision(db, "rev_public_list", artifactId, 2, "public/list.html", 5, "ready");
		await Artifacts.setCurrentRevision(db, artifactId, "rev_public_list");
		const res2 = await handleListShares(ownerRequest(`/api/artifacts/${artifactId}/shares`), db, artifactId);
		const body2 = await res2.json() as { shares: Array<{ revision_id: string }> };
		expect(body2.shares[0].revision_id).toBe("rev_public_list");
	});

	it("rejects invalid durations, revokes immediately, and never reactivates revoked or expired links", async () => {
		const invalid = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 60 }), db, artifactId);
		expect(invalid.status).toBe(400);

		const create = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const { token } = await create.json() as { token: string };
		const revoked = await handleRevokeShare(ownerRequest(`/api/artifacts/${artifactId}/shares/${token}`, "DELETE"), db, artifactId, token);
		expect(revoked.status).toBe(200);
		expect((await handlePublicShare(new Request(`${origin}/s/${token}`), db, token)).status).toBe(404);

		const recreated = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const reBody = await recreated.json() as { token: string };
		expect(recreated.status).toBe(201);
		expect(reBody.token).not.toBe(token);

		await handleRevokeShare(ownerRequest(`/api/artifacts/${artifactId}/shares/${reBody.token}`, "DELETE"), db, artifactId, reBody.token);
		await db.prepare("INSERT INTO public_shares (token, artifact_id, revision_id, expires_at) VALUES (?, ?, ?, ?)")
			.bind("e".repeat(48), artifactId, "rev_public_share", Math.floor(Date.now() / 1000) - 1).run();
		const afterExpiry = await handleCreateShare(ownerRequest(`/api/artifacts/${artifactId}/shares`, "POST", { ttl_seconds: 86400 }), db, artifactId);
		const afterBody = await afterExpiry.json() as { token: string };
		expect(afterExpiry.status).toBe(201);
		expect(afterBody.token).not.toBe("e".repeat(48));
	});
});
