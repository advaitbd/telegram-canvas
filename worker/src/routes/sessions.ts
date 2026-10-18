/**
 * Viewer session routes.
 *
 * All endpoints require a valid shell session cookie that encodes
 * the owner_hash.  Cross-owner enumeration returns empty results
 * (not 404), avoiding side-channel user enumeration.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getOwnerFromCookie } from "./auth";
import * as Artifacts from "../db/artifacts";
import { jsonError, jsonOk } from "../lib/http";

export async function handleBootstrap(request: Request, db: D1Database, identityKey: string): Promise<Response> {
	const ownerHash = await getOwnerFromCookie(request, identityKey);
	if (!ownerHash) return jsonError(401, "Unauthorized");
	const canvas = await db.prepare(`SELECT
		s.id AS session_id, s.title AS session_title, s.last_active_at, s.expires_at,
		a.id AS artifact_id, a.title AS artifact_title, a.current_revision_id, a.trashed_at, a.created_at
		FROM session_records s
		JOIN artifacts a ON a.session_id = s.id
		JOIN artifact_revisions r ON r.id = a.current_revision_id
		WHERE s.owner_hash = ? AND s.expires_at > unixepoch()
			AND a.trashed_at IS NULL AND r.status = 'ready'
		ORDER BY s.last_active_at DESC, s.id DESC, a.created_at DESC, a.id DESC
		LIMIT 1`).bind(ownerHash).first<{
		session_id: string; session_title: string; last_active_at: number; expires_at: number;
		artifact_id: string; artifact_title: string; current_revision_id: string; trashed_at: number | null; created_at: number;
	}>();
	if (!canvas) return jsonOk({ canvas: null });
	return jsonOk({ canvas: {
		session: { id: canvas.session_id, title: canvas.session_title, artifact_count: 1, last_active_at: canvas.last_active_at, expires_at: canvas.expires_at },
		artifact: { id: canvas.artifact_id, session_id: canvas.session_id, title: canvas.artifact_title, current_revision_id: canvas.current_revision_id, trashed_at: canvas.trashed_at, created_at: canvas.created_at },
	} });
}

/**
 * GET /api/sessions — list non-expired sessions that have at least one
 * non-trashed canvas artifact, owned by the authenticated user.
 */
export async function handleListSessions(
	request: Request,
	db: D1Database,
	identityKey: string,
): Promise<Response> {
	const ownerHash = await getOwnerFromCookie(request, identityKey);
	if (!ownerHash) {
		return jsonError(401, "Unauthorized");
	}

	const sessions = await db.prepare(`SELECT
		s.id, s.title, COUNT(a.id) AS artifact_count, s.last_active_at, s.expires_at
		FROM session_records s
		JOIN artifacts a ON a.session_id = s.id
		JOIN artifact_revisions r ON r.id = a.current_revision_id AND r.artifact_id = a.id
		WHERE s.owner_hash = ? AND s.expires_at > unixepoch()
			AND a.trashed_at IS NULL AND r.status = 'ready'
		GROUP BY s.id
		ORDER BY s.last_active_at DESC, s.id DESC`).bind(ownerHash).all();

	return jsonOk({ sessions: sessions.results ?? [] });
}

/** GET /api/canvases — an owner-scoped, management-first canvas archive. */
export async function handleListCanvases(
	request: Request,
	db: D1Database,
	identityKey: string,
): Promise<Response> {
	const ownerHash = await getOwnerFromCookie(request, identityKey);
	if (!ownerHash) return jsonError(401, "Unauthorized");
	return jsonOk({ canvases: await Artifacts.listCanvasesByOwner(db, ownerHash) });
}

/**
 * GET /api/sessions/:id/artifacts — list non-trashed artifacts for a session.
 */
export async function handleListArtifacts(
	request: Request,
	db: D1Database,
	sessionId: string,
	identityKey: string,
): Promise<Response> {
	const ownerHash = await getOwnerFromCookie(request, identityKey);
	if (!ownerHash) {
		return jsonError(401, "Unauthorized");
	}

	const artifacts = await Artifacts.listArtifacts(db, sessionId, ownerHash);
	return jsonOk({ artifacts });
}
