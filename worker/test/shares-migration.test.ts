/**
 * Migration 0006 regression: public links must survive revision pruning.
 *
 * Reproduces the old schema (revision_id FK ON DELETE CASCADE), applies the
 * forward-only migration, and proves tokens/expiry/created_at are preserved,
 * the FK is gone, and a link pinned to a now-deleted revision still serves the
 * artifact's live ready revision.
 */
/// <reference types="vite/client" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { handlePublicDocument } from "../src/routes/shares";
import MIGRATION_SQL from "../migrations/0006_public_shares_artifact_scoped.sql?raw";

const OLD_PUBLIC_SHARES = `CREATE TABLE public_shares (
	token TEXT PRIMARY KEY,
	artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
	revision_id TEXT NOT NULL REFERENCES artifact_revisions(id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX idx_public_shares_artifact ON public_shares(artifact_id, expires_at);
CREATE INDEX idx_public_shares_expiry ON public_shares(expires_at);`;

/** D1 exec splits per line; run each `;`-terminated statement explicitly. */
async function applySql(db: D1Database, sql: string): Promise<void> {
	const withoutComments = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
	for (const statement of withoutComments.split(";").map((part) => part.trim()).filter(Boolean)) {
		await db.prepare(statement).run();
	}
}

describe("migration 0006 public_shares", () => {
	let db: D1Database;
	let r2: R2Bucket;
	const token = "a".repeat(48);
	const expiresAt = Math.floor(Date.now() / 1000) + 86400;

	beforeAll(async () => {
		db = env.CANVAS_DB;
		r2 = env.CANVAS_ARTIFACTS;
		await db.prepare("CREATE TABLE IF NOT EXISTS session_records (id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, session_hash TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', chat_name TEXT NOT NULL DEFAULT '', last_active_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
		await db.prepare("CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', current_revision_id TEXT, trashed_at INTEGER, purge_after INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
		await db.prepare("CREATE TABLE IF NOT EXISTS artifact_revisions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, ordinal INTEGER NOT NULL, r2_key TEXT NOT NULL, content_bytes INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)").run();
		await applySql(db, OLD_PUBLIC_SHARES);

		await db.prepare("INSERT INTO session_records (id, owner_hash, session_hash, title, chat_name, last_active_at, expires_at, created_at, updated_at) VALUES ('ses_mig','owner_mig','hash_mig','','',unixepoch(),unixepoch()+2592000,unixepoch(),unixepoch())").run();
		await db.prepare("INSERT INTO artifacts (id, session_id, title, current_revision_id, created_at, updated_at) VALUES ('art_mig','ses_mig','Migrated','rev_new',unixepoch(),unixepoch())").run();
		await db.prepare("INSERT INTO artifact_revisions (id, artifact_id, ordinal, r2_key, content_bytes, status, created_at) VALUES ('rev_old','art_mig',1,'mig/old.html',10,'ready',unixepoch())").run();
		await db.prepare("INSERT INTO artifact_revisions (id, artifact_id, ordinal, r2_key, content_bytes, status, created_at) VALUES ('rev_new','art_mig',2,'mig/new.html',10,'ready',unixepoch())").run();
		await db.prepare("INSERT INTO public_shares (token, artifact_id, revision_id, expires_at) VALUES (?, 'art_mig', 'rev_old', ?)").bind(token, expiresAt).run();
		await r2.put("mig/new.html", "<h1>live new revision</h1>");
	});

	it("preserves every token and drops only the revision FK", async () => {
		await applySql(db, MIGRATION_SQL);

		const row = await db.prepare("SELECT token, artifact_id, revision_id, expires_at FROM public_shares WHERE token = ?")
			.bind(token).first<{ token: string; artifact_id: string; revision_id: string; expires_at: number }>();
		expect(row).toMatchObject({ token, artifact_id: "art_mig", revision_id: "rev_old", expires_at: expiresAt });

		const fks = await db.prepare("PRAGMA foreign_key_list(public_shares)").all<{ table: string; from: string }>();
		expect(fks.results?.map((fk) => fk.from)).toEqual(["artifact_id"]);
	});

	it("keeps the link working after the linked revision is pruned", async () => {
		await applySql(db, MIGRATION_SQL);
		// Prune the old revision the link was created against.
		await db.prepare("DELETE FROM artifact_revisions WHERE id = 'rev_old'").run();

		const still = await db.prepare("SELECT COUNT(*) AS cnt FROM public_shares WHERE token = ?").bind(token).first<{ cnt: number }>();
		expect(still?.cnt).toBe(1);

		const document = await handlePublicDocument(db, r2, token);
		expect(document.status).toBe(200);
		expect(await document.text()).toContain("live new revision");
	});
});
