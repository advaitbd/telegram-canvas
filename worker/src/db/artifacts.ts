/**
 * Artifact and artifact_revision repository.
 *
 * Every query that takes an artifact_id also constrains by owner_hash
 * (resolved through the session foreign key) to prevent cross-owner
 * access and enumeration.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { TRASH_RETENTION_DAYS } from "../lib/limits";

/** Row shape for artifacts. */
export interface ArtifactRecord {
	id: string;
	session_id: string;
	title: string;
	current_revision_id: string | null;
	trashed_at: number | null;
	purge_after: number | null;
	created_at: number;
	updated_at: number;
}

/** Row shape for artifact_revisions. */
export interface RevisionRecord {
	id: string;
	artifact_id: string;
	ordinal: number;
	r2_key: string;
	content_bytes: number;
	created_at: number;
}

// ---------------------------------------------------------------------------
// Artifact CRUD
// ---------------------------------------------------------------------------

/** Verify the caller owns the session the artifact belongs to. */

/** Count non-purged (trashed or active) artifacts in a session. */
export async function countArtifactsInSession(
	db: D1Database,
	session_id: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS cnt
       FROM artifacts
       WHERE session_id = ? AND (purge_after IS NULL OR purge_after > unixepoch())`,
		)
		.bind(session_id)
		.first<{ cnt: number }>();

	return row?.cnt ?? 0;
}

/** Create a new artifact. Returns the artifact id. */
export async function createArtifact(
	db: D1Database,
	id: string,
	session_id: string,
	title: string,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	await db
		.prepare(
			`INSERT INTO artifacts (id, session_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(id, session_id, title.slice(0, 160), now, now)
		.run();

	return id;
}

/** Get an artifact by id, constrained by owner_hash. Returns null on miss. */
export async function getArtifact(
	db: D1Database,
	artifact_id: string,
	owner_hash: string,
): Promise<ArtifactRecord | null> {
	const row = await db
		.prepare(
			`SELECT a.id, a.session_id, a.title, a.current_revision_id,
               a.trashed_at, a.purge_after, a.created_at, a.updated_at
       FROM artifacts a
       JOIN session_records s ON s.id = a.session_id
       WHERE a.id = ? AND s.owner_hash = ?`,
		)
		.bind(artifact_id, owner_hash)
		.first<ArtifactRecord>();

	return row ?? null;
}

/** List non-trashed artifacts in a session, constrained by owner_hash. */
export async function listArtifacts(
	db: D1Database,
	session_id: string,
	owner_hash: string,
): Promise<ArtifactRecord[]> {
	const rows = await db
		.prepare(
			`SELECT a.id, a.session_id, a.title, a.current_revision_id,
               a.trashed_at, a.purge_after, a.created_at, a.updated_at
       FROM artifacts a
       JOIN session_records s ON s.id = a.session_id
       WHERE a.session_id = ? AND s.owner_hash = ? AND a.trashed_at IS NULL
       ORDER BY a.created_at DESC`,
		)
		.bind(session_id, owner_hash)
		.all<ArtifactRecord>();

	return rows.results ?? [];
}

/** Trash an artifact (soft delete), constrained by owner_hash. */
export async function trashArtifact(
	db: D1Database,
	artifact_id: string,
	owner_hash: string,
): Promise<boolean> {
	const now = Math.floor(Date.now() / 1000);
	const purge = now + TRASH_RETENTION_DAYS * 86400;

	const result = await db
		.prepare(
			`UPDATE artifacts
       SET trashed_at = ?, purge_after = ?, updated_at = ?
       WHERE id = ? AND id IN (
         SELECT a.id FROM artifacts a
         JOIN session_records s ON s.id = a.session_id
         WHERE a.id = ? AND s.owner_hash = ?
       )`,
		)
		.bind(now, purge, now, artifact_id, artifact_id, owner_hash)
		.run();

	return result.meta.changes > 0;
}

/** Select artifacts that are past their purge_after, for permanent cleanup. */
export async function selectPurgeCandidates(db: D1Database): Promise<ArtifactRecord[]> {
	const now = Math.floor(Date.now() / 1000);
	const rows = await db
		.prepare(
			`SELECT id, session_id, title, current_revision_id,
               trashed_at, purge_after, created_at, updated_at
       FROM artifacts
       WHERE purge_after IS NOT NULL AND purge_after <= ?`,
		)
		.bind(now)
		.all<ArtifactRecord>();

	return rows.results ?? [];
}

/** Permanently delete an artifact (cascades to revisions). */
export async function deleteArtifactPermanent(
	db: D1Database,
	artifact_id: string,
): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM artifacts WHERE id = ?")
		.bind(artifact_id)
		.run();

	return result.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Revision CRUD
// ---------------------------------------------------------------------------

/** Create a new revision. Returns the revision id. */
export async function createRevision(
	db: D1Database,
	id: string,
	artifact_id: string,
	ordinal: number,
	r2_key: string,
	content_bytes: number,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	await db
		.prepare(
			`INSERT INTO artifact_revisions (id, artifact_id, ordinal, r2_key, content_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, artifact_id, ordinal, r2_key, content_bytes, now)
		.run();

	return id;
}

/** Set the artifact's current_revision_id. */
export async function setCurrentRevision(
	db: D1Database,
	artifact_id: string,
	revision_id: string,
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await db
		.prepare(
			"UPDATE artifacts SET current_revision_id = ?, updated_at = ? WHERE id = ?",
		)
		.bind(revision_id, now, artifact_id)
		.run();
}

/** List revisions for an artifact, newest first. */
export async function listRevisions(
	db: D1Database,
	artifact_id: string,
): Promise<RevisionRecord[]> {
	const rows = await db
		.prepare(
			`SELECT id, artifact_id, ordinal, r2_key, content_bytes, created_at
       FROM artifact_revisions
       WHERE artifact_id = ?
       ORDER BY ordinal DESC`,
		)
		.bind(artifact_id)
		.all<RevisionRecord>();

	return rows.results ?? [];
}

/** Get the N oldest revisions for pruning (ordered oldest first). */
export async function selectOldestRevisions(
	db: D1Database,
	artifact_id: string,
	keep_count: number,
): Promise<RevisionRecord[]> {
	const rows = await db
		.prepare(
			`SELECT id, artifact_id, ordinal, r2_key, content_bytes, created_at
       FROM artifact_revisions
       WHERE artifact_id = ?
       ORDER BY ordinal ASC
       LIMIT ?`,
		)
		.bind(artifact_id, Math.max(0, keep_count))
		.all<RevisionRecord>();

	// We return the ones BEYOND keep_count
	const all = rows.results ?? [];
	return all.slice(keep_count);
}

/** Delete a list of revision ids (for pruning). */
export async function deleteRevisions(
	db: D1Database,
	revision_ids: string[],
): Promise<number> {
	if (revision_ids.length === 0) return 0;

	// D1 prepared statements don't support IN with a list directly,
	// so we build placeholders.
	const placeholders = revision_ids.map(() => "?").join(",");
	const result = await db
		.prepare(
			`DELETE FROM artifact_revisions WHERE id IN (${placeholders})`,
		)
		.bind(...revision_ids)
		.run();

	return result.meta.changes;
}

/** Get all revision R2 keys for an artifact (for cleanup after cascade). */
export async function selectRevisionR2Keys(
	db: D1Database,
	artifact_id: string,
): Promise<string[]> {
	const rows = await db
		.prepare(
			"SELECT r2_key FROM artifact_revisions WHERE artifact_id = ?",
		)
		.bind(artifact_id)
		.all<{ r2_key: string }>();

	return (rows.results ?? []).map((r) => r.r2_key);
}
