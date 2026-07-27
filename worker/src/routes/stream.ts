/**
 * WebSocket stream route — live updates via the ArtifactRoom DO.
 *
 * The shell connects to GET /api/stream/:sessionId, which upgrades to
 * a WebSocket. The ArtifactRoom DO handles the WebSocket lifecycle,
 * hibernation, and broadcasts.
 *
 * Authorization is checked before upgrading: the shell session cookie
 * must own the requested session.
 */

import type { D1Database, DurableObjectNamespace } from "@cloudflare/workers-types";
import { getOwnerFromCookie } from "./auth";
import * as Sessions from "../db/sessions";
import { jsonError } from "../lib/http";

export async function handleStream(
	request: Request,
	env: {
		CANVAS_DB: D1Database;
		ARTIFACT_ROOM: DurableObjectNamespace;
	},
	sessionId: string,
): Promise<Response> {
	// Authorization: check the shell cookie
	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) {
		return jsonError(401, "Unauthorized");
	}

	// Resolve the session's owner by checking the session exists (without owner check here)
	// The DO will re-validate on connect
	const sessions = await Sessions.listSessionsByOwner(env.CANVAS_DB, ownerHash);
	const session = sessions.find((s) => s.id === sessionId);
	if (!session) {
		return jsonError(404, "Session not found or not owned by you");
	}

	// Forward the WebSocket upgrade to the Durable Object
	const roomId = env.ARTIFACT_ROOM.idFromName(`session:${sessionId}`);
	const stub = env.ARTIFACT_ROOM.get(roomId);

	return stub.fetch(request);
}
