/**
 * Session record repository.
 *
 * All queries that accept a client-facing session id MUST constrain
 * by owner_hash so cross-owner enumeration returns empty results.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { SESSION_EXPIRY_DAYS } from "../lib/limits";

/** Row shape for session_records. */
export interface SessionRecord {
	id: string;
	owner_hash: string;
	session_hash: string;
	title: string;
	last_active_at: number;
	expires_at: number;
	created_at: number;
	updated_at: number;
}

/** Create a new session record. Returns the created id. */
export async function createSession(
	db: D1Database,
	id: string,
	owner_hash: string,
	session_hash: string,
	title: string,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const expires = now + SESSION_EXPIRY_DAYS * 86400;

	await db
		.prepare(
			`INSERT INTO session_records (id, owner_hash, session_hash, title, last_active_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, owner_hash, session_hash, title.slice(0, 160), now, expires, now, now)
		.run();

	return id;
}

/** Look up a session by (owner_hash, session_hash). Returns null on miss. */
export async function getSessionByHashes(
	db: D1Database,
	owner_hash: string,
	session_hash: string,
): Promise<SessionRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, owner_hash, session_hash, title, last_active_at, expires_at, created_at, updated_at
       FROM session_records
       WHERE owner_hash = ? AND session_hash = ?`,
		)
		.bind(owner_hash, session_hash)
		.first<SessionRecord>();

	return row ?? null;
}

/** List non-expired sessions owned by a given owner_hash. */
export async function listSessionsByOwner(
	db: D1Database,
	owner_hash: string,
): Promise<SessionRecord[]> {
	const now = Math.floor(Date.now() / 1000);
	const rows = await db
		.prepare(
			`SELECT id, owner_hash, session_hash, title, last_active_at, expires_at, created_at, updated_at
       FROM session_records
       WHERE owner_hash = ? AND expires_at > ?
       ORDER BY last_active_at DESC`,
		)
		.bind(owner_hash, now)
		.all<SessionRecord>();

	return rows.results ?? [];
}

/** Refresh last_active_at for a session (extends expiry). */
export async function touchSession(
	db: D1Database,
	session_id: string,
	owner_hash: string,
): Promise<boolean> {
	const now = Math.floor(Date.now() / 1000);
	const expires = now + SESSION_EXPIRY_DAYS * 86400;

	const result = await db
		.prepare(
			`UPDATE session_records
       SET last_active_at = ?, expires_at = ?, updated_at = ?
       WHERE id = ? AND owner_hash = ?`,
		)
		.bind(now, expires, now, session_id, owner_hash)
		.run();

	return result.meta.changes > 0;
}

/** Select sessions whose expiry has passed, for cleanup. */
export async function selectExpiredSessions(
	db: D1Database,
): Promise<SessionRecord[]> {
	const now = Math.floor(Date.now() / 1000);
	const rows = await db
		.prepare(
			`SELECT id, owner_hash, session_hash, title, last_active_at, expires_at, created_at, updated_at
       FROM session_records
       WHERE expires_at <= ?`,
		)
		.bind(now)
		.all<SessionRecord>();

	return rows.results ?? [];
}

/** Delete a session by id. Cascades to artifacts and revisions. */
export async function deleteSession(db: D1Database, session_id: string): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM session_records WHERE id = ?")
		.bind(session_id)
		.run();

	return result.meta.changes > 0;
}
