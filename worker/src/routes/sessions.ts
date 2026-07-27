/**
 * Viewer session routes.
 *
 * All endpoints require a valid shell session cookie that encodes
 * the owner_hash.  Cross-owner enumeration returns empty results
 * (not 404), avoiding side-channel user enumeration.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getOwnerFromCookie } from "./auth";
import * as Sessions from "../db/sessions";
import * as Artifacts from "../db/artifacts";
import { jsonError, jsonOk } from "../lib/http";

/**
 * GET /api/sessions — list non-expired sessions that have at least one
 * non-trashed canvas artifact, owned by the authenticated user.
 */
export async function handleListSessions(
	request: Request,
	db: D1Database,
): Promise<Response> {
	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) {
		return jsonError(401, "Unauthorized");
	}

	const allSessions = await Sessions.listSessionsByOwner(db, ownerHash);

	// Filter to sessions with at least one non-trashed artifact
	const eligible = await Promise.all(
		allSessions.map(async (s) => {
			const artifacts = await Artifacts.listArtifacts(db, s.id, ownerHash);
			return artifacts.length > 0
				? {
						id: s.id,
						title: s.title,
						artifact_count: artifacts.length,
						last_active_at: s.last_active_at,
						expires_at: s.expires_at,
				  }
				: null;
		}),
	);

	return jsonOk({ sessions: eligible.filter(Boolean) });
}

/**
 * GET /api/sessions/:id/artifacts — list non-trashed artifacts for a session.
 */
export async function handleListArtifacts(
	request: Request,
	db: D1Database,
	sessionId: string,
): Promise<Response> {
	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) {
		return jsonError(401, "Unauthorized");
	}

	const artifacts = await Artifacts.listArtifacts(db, sessionId, ownerHash);
	return jsonOk({ artifacts });
}
