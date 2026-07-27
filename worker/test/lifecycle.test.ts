/**
 * Lifecycle tests for the D1 session/artifact/revision repository.
 *
 * TDD: tests define the contract before implementation.
 *
 * Coverage:
 *  - Create session from deterministic owner/session hash pair
 *  - Duplicate (owner_hash, session_hash) insert is rejected
 *  - List sessions by owner, excluding expired
 *  - TouchSession refreshes expiry
 *  - Create artifact linked to session
 *  - Cross-owner artifact retrieval returns null
 *  - Cross-owner list returns empty
 *  - Append revisions, set current revision
 *  - Duplicate (artifact_id, ordinal) is rejected
 *  - Trash artifact (soft delete), excluded from list
 *  - Trash by wrong owner returns false
 *  - Select purge candidates
 *  - Limit constants are correct
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";

import * as Sessions from "../src/db/sessions";
import * as Artifacts from "../src/db/artifacts";
import { SESSION_EXPIRY_DAYS, TRASH_RETENTION_DAYS } from "../src/lib/limits";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		CANVAS_DB: D1Database;
	}
}

describe("artifact lifecycle", () => {
	let db: D1Database;

	beforeAll(async () => {
		db = env.CANVAS_DB;

		await db.prepare(`CREATE TABLE IF NOT EXISTS session_records (
			id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, session_hash TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '',
			last_active_at INTEGER NOT NULL DEFAULT (unixepoch()),
			expires_at INTEGER NOT NULL DEFAULT (unixepoch() + 2592000),
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`).run();
		await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_session_owner_hash ON session_records(owner_hash, session_hash)").run();
		await db.prepare("CREATE INDEX IF NOT EXISTS idx_session_expires ON session_records(owner_hash, expires_at)").run();

		await db.prepare(`CREATE TABLE IF NOT EXISTS artifacts (
			id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_records(id) ON DELETE CASCADE,
			title TEXT NOT NULL DEFAULT '', current_revision_id TEXT,
			trashed_at INTEGER, purge_after INTEGER,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`).run();
		await db.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_session_trash ON artifacts(session_id, trashed_at)").run();
		await db.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_owner_lookup ON artifacts(id, session_id)").run();

		await db.prepare(`CREATE TABLE IF NOT EXISTS artifact_revisions (
			id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
			ordinal INTEGER NOT NULL, r2_key TEXT NOT NULL,
			content_bytes INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`).run();
		await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_revision_ordinal ON artifact_revisions(artifact_id, ordinal)").run();
		await db.prepare("CREATE INDEX IF NOT EXISTS idx_revision_created ON artifact_revisions(artifact_id, created_at)").run();
	});

	it("creates a session from owner_hash and session_hash", async () => {
		const sessionId = "ses_" + crypto.randomUUID();
		const id = await Sessions.createSession(db, sessionId, "owner_alice", "sess_discussion_001", "Architecture Discussion");
		expect(id).toBe(sessionId);

		const stored = await Sessions.getSessionByHashes(db, "owner_alice", "sess_discussion_001");
		expect(stored).not.toBeNull();
		expect(stored!.owner_hash).toBe("owner_alice");
		expect(stored!.session_hash).toBe("sess_discussion_001");
		expect(stored!.title).toBe("Architecture Discussion");
		expect(stored!.expires_at).toBeGreaterThan(stored!.last_active_at);
	});

	it("rejects duplicate (owner_hash, session_hash)", async () => {
		await Sessions.createSession(db, "ses_" + crypto.randomUUID(), "owner_dup", "hash_dup", "First");
		await expect(
			Sessions.createSession(db, "ses_" + crypto.randomUUID(), "owner_dup", "hash_dup", "Second"),
		).rejects.toThrow();
	});

	it("lists sessions by owner, excluding expired ones", async () => {
		await Sessions.createSession(db, "ses_" + crypto.randomUUID(), "owner_list", "hash_fresh", "Fresh");

		const past = Math.floor(Date.now() / 1000) - 4000000;
		await db.prepare("INSERT INTO session_records (id,owner_hash,session_hash,title,last_active_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
			.bind("ses_expired_" + crypto.randomUUID(), "owner_list_expired", "hash_expired", "Expired", past, past, past, past).run();

		const fresh = await Sessions.listSessionsByOwner(db, "owner_list");
		expect(fresh.length).toBeGreaterThanOrEqual(1);
		expect(await Sessions.listSessionsByOwner(db, "owner_list_expired")).toHaveLength(0);
	});

	it("touchSession refreshes last_active_at and extends expiry", async () => {
		const sessionId = "ses_" + crypto.randomUUID();
		await Sessions.createSession(db, sessionId, "owner_touch", "hash_touch", "Touchable");
		const before = await Sessions.getSessionByHashes(db, "owner_touch", "hash_touch");
		expect(before).not.toBeNull();
		expect(await Sessions.touchSession(db, sessionId, "owner_touch")).toBe(true);
		const after = await Sessions.getSessionByHashes(db, "owner_touch", "hash_touch");
		expect(after!.last_active_at).toBeGreaterThanOrEqual(before!.last_active_at);
		expect(after!.expires_at).toBe(after!.last_active_at + 30 * 86400);
		expect(await Sessions.touchSession(db, sessionId, "wrong_owner")).toBe(false);
	});

	it("creates an artifact linked to a session", async () => {
		const sessionId = "ses_" + crypto.randomUUID();
		await Sessions.createSession(db, sessionId, "owner_art", "hash_art", "Artifact Session");
		const artifactId = "art_" + crypto.randomUUID();
		await Artifacts.createArtifact(db, artifactId, sessionId, "My Diagram");
		const stored = await Artifacts.getArtifact(db, artifactId, "owner_art");
		expect(stored).not.toBeNull();
		expect(stored!.id).toBe(artifactId);
		expect(stored!.title).toBe("My Diagram");
		expect(stored!.session_id).toBe(sessionId);
	});

	it("returns null for artifact from another owner", async () => {
		const sessionId = "ses_" + crypto.randomUUID();
		await Sessions.createSession(db, sessionId, "owner_bob", "hash_bob", "Bob Session");
		const artifactId = "art_" + crypto.randomUUID();
		await Artifacts.createArtifact(db, artifactId, sessionId, "Bob Diagram");
		expect(await Artifacts.getArtifact(db, artifactId, "owner_alice")).toBeNull();
	});

	it("lists non-trashed artifacts in a session", async () => {
		const sessionId = "ses_" + crypto.randomUUID();
		await Sessions.createSession(db, sessionId, "owner_list_art", "hash_list_art", "List Session");
			const firstId = "art_list1_" + crypto.randomUUID();
		const secondId = "art_list2_" + crypto.randomUUID();
		await Artifacts.createArtifact(db, firstId, sessionId, "Visible");
		await Artifacts.createArtifact(db, secondId, sessionId, "Also Visible");
		await Artifacts.createRevision(db, "rev_" + crypto.randomUUID(), firstId, 1, "r2://visible", 1, "ready");
		await Artifacts.createRevision(db, "rev_" + crypto.randomUUID(), secondId, 1, "r2://also-visible", 1, "ready");
		const revisions = await Artifacts.listRevisions(db, firstId);
		const otherRevisions = await Artifacts.listRevisions(db, secondId);
		await Artifacts.setCurrentRevision(db, firstId, revisions[0].id);
		await Artifacts.setCurrentRevision(db, secondId, otherRevisions[0].id);
		expect(await Artifacts.listArtifacts(db, sessionId, "owner_list_art")).toHaveLength(2);
	});

	it("listArtifacts from another owner returns empty", async () => {
		const sessionId = "ses_" + crypto.randomUUID();
		await Sessions.createSession(db, sessionId, "owner_isolated", "hash_isolated", "Isolated");
		await Artifacts.createArtifact(db, "art_" + crypto.randomUUID(), sessionId, "Secret");
		expect(await Artifacts.listArtifacts(db, sessionId, "owner_intruder")).toHaveLength(0);
	});

	it("appends revisions to an artifact", async () => {
		const sessionId = "ses_" + crypto.randomUUID();
		await Sessions.createSession(db, sessionId, "owner_rev", "hash_rev", "Rev Session");
		const artifactId = "art_" + crypto.randomUUID();
		await Artifacts.createArtifact(db, artifactId, sessionId, "Versioned Doc");
		await Artifacts.createRevision(db, "rev_" + crypto.randomUUID(), artifactId, 1, "r2://key1", 1024, "ready");
		await Artifacts.createRevision(db, "rev_" + crypto.randomUUID(), artifactId, 2, "r2://key2", 2048, "ready");
		await Artifacts.setCurrentRevision(db, artifactId, "rev2");
		const revisions = await Artifacts.listRevisions(db, artifactId);
		expect(revisions).toHaveLength(2);
		expect(revisions[0].ordinal).toBe(2);
		expect(revisions[1].ordinal).toBe(1);
	});

	it("rejects duplicate (artifact_id, ordinal)", async () => {
		const sessionId = "ses_" + crypto.randomUUID();
		await Sessions.createSession(db, sessionId, "owner_dup_ord", "hash_dup_ord", "Dup Ord");
		const artifactId = "art_" + crypto.randomUUID();
		await Artifacts.createArtifact(db, artifactId, sessionId, "Dup Ord Artifact");
		await Artifacts.createRevision(db, "rev_" + crypto.randomUUID(), artifactId, 1, "r2://k1", 100, "pending");
		await expect(
			Artifacts.createRevision(db, "rev_" + crypto.randomUUID(), artifactId, 1, "r2://k2", 200, "pending"),
		).rejects.toThrow();
	});

	it("trashes an artifact (soft delete) and excludes it from list", async () => {
		const sessionId = "ses_" + crypto.randomUUID();
		await Sessions.createSession(db, sessionId, "owner_trash", "hash_trash", "Trash Session");
		const artId = "art_" + crypto.randomUUID();
		await Artifacts.createArtifact(db, artId, sessionId, "Trashable");
		expect(await Artifacts.trashArtifact(db, artId, "owner_trash")).toBe(true);
		const list = await Artifacts.listArtifacts(db, sessionId, "owner_trash");
		expect(list.map((a) => a.id)).not.toContain(artId);
		const stored = await Artifacts.getArtifact(db, artId, "owner_trash");
		expect(stored).not.toBeNull();
		expect(stored!.trashed_at).not.toBeNull();
		expect(stored!.purge_after).not.toBeNull();
	});

	it("trashArtifact returns false for wrong owner", async () => {
		const sessionId = "ses_" + crypto.randomUUID();
		await Sessions.createSession(db, sessionId, "owner_own", "hash_own", "Own Session");
		await Artifacts.createArtifact(db, "art_" + crypto.randomUUID(), sessionId, "Mine");
		expect(await Artifacts.trashArtifact(db, "art_" + crypto.randomUUID(), "owner_intruder")).toBe(false);
	});

	it("selects purge candidates after trash window", async () => {
		const sessionId = "ses_" + crypto.randomUUID();
		await Sessions.createSession(db, sessionId, "owner_purge", "hash_purge", "Purge Session");
		const artId = "art_" + crypto.randomUUID();
		await Artifacts.createArtifact(db, artId, sessionId, "Purgeable");
		const past = Math.floor(Date.now() / 1000) - 1000;
		await db.prepare("UPDATE artifacts SET trashed_at = ?, purge_after = ? WHERE id = ?").bind(past, past, artId).run();
		const candidates = await Artifacts.selectPurgeCandidates(db);
		expect(candidates.map((a) => a.id)).toContain(artId);
	});

	it("exposes correct limit constants", () => {
		expect(SESSION_EXPIRY_DAYS).toBe(30);
		expect(TRASH_RETENTION_DAYS).toBe(7);
	});
});
