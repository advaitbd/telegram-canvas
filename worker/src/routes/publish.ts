/**
 * POST /internal/publish — Hermes plugin publishes an HTML artifact.
 *
 * Validates the publisher HMAC signature, enforces limits, writes the
 * HTML blob to R2, creates/updates D1 metadata, and broadcasts an
 * update event via the per-session Durable Object room.
 *
 * Idempotent and crash-safe: the revision state machine (pending →
 * ready/failed) ensures that a crash after R2 write but before D1
 * commit is reconciled by the scheduled cleanup cron.
 */

import type { R2Bucket, D1Database, DurableObjectNamespace } from "@cloudflare/workers-types";
import { validatePublishRequest, PublisherAuthError, type PublisherSecrets } from "../auth/publisher";
import { deriveOwnerHash, deriveSessionHash } from "../auth/identity";
import * as Sessions from "../db/sessions";
import * as Artifacts from "../db/artifacts";
import { MAX_REVISION_BYTES, MAX_ARTIFACTS_PER_SESSION, MAX_REVISIONS_PER_ARTIFACT } from "../lib/limits";
import type { ArtifactUpdateEvent } from "../durable/artifact-room";
import { jsonError, jsonOk, authErrorToResponse } from "../lib/http";

/** Expected shape of the publish request body. */
interface PublishBody {
	telegram_creator_id: string;
	hermes_session_id: string;
	session_title?: string;
	artifact_id?: string;
	title: string;
	html: string;
}

export async function handlePublish(
	request: Request,
	env: {
		CANVAS_DB: D1Database;
		CANVAS_ARTIFACTS: R2Bucket;
		ARTIFACT_ROOM: DurableObjectNamespace;
		PUBLISHER_SECRET: string;
		IDENTITY_HMAC_KEY: string;
	},
): Promise<Response> {
	try {
		// Resolve publisher secrets for key rotation
		const secrets: PublisherSecrets = {
			"key1": env.PUBLISHER_SECRET,
		};

		// 1. Validate HMAC signature
		const claim = await validatePublishRequest(request, secrets, env.CANVAS_DB);

		// 2. Parse body
		let body: PublishBody;
		try {
			body = JSON.parse(claim.rawBody);
		} catch {
			return jsonError(400, "Invalid JSON body");
		}

		// 3. Validate required fields
		if (!body.telegram_creator_id || !body.hermes_session_id) {
			return jsonError(400, "Missing telegram_creator_id or hermes_session_id");
		}
		if (!body.title || typeof body.title !== "string") {
			return jsonError(400, "Missing or invalid title");
		}
		if (!body.html || typeof body.html !== "string") {
			return jsonError(400, "Missing or invalid html");
		}
		if (body.title.length > 160) {
			return jsonError(400, "Title exceeds 160 characters");
		}

		// 4. Check HTML size
		const htmlBytes = new TextEncoder().encode(body.html).byteLength;
		if (htmlBytes > MAX_REVISION_BYTES) {
			return jsonError(413, "HTML body exceeds maximum size");
		}

		// 5. Derive identity hashes
		const ownerHash = await deriveOwnerHash(body.telegram_creator_id, env.IDENTITY_HMAC_KEY);
		const sessionHash = await deriveSessionHash(body.hermes_session_id, env.IDENTITY_HMAC_KEY);

		// 6. Find or create session
		let session = await Sessions.getSessionByHashes(env.CANVAS_DB, ownerHash, sessionHash);
		if (!session) {
			const sessionId = crypto.randomUUID();
			await Sessions.createSession(
				env.CANVAS_DB,
				sessionId,
				ownerHash,
				sessionHash,
				(body.session_title || body.title).slice(0, 160),
			);
			session = await Sessions.getSessionByHashes(env.CANVAS_DB, ownerHash, sessionHash);
			if (!session) {
				return jsonError(500, "Failed to create session");
			}
		}

		// 7. Find or create artifact
		let artifactId: string;
		let isNewArtifact = false;

		if (body.artifact_id) {
			// Check the artifact exists and belongs to this owner
			const existing = await Artifacts.getArtifact(env.CANVAS_DB, body.artifact_id, ownerHash);
			if (!existing) {
				return jsonError(404, "Artifact not found or not owned by this publisher");
			}
			if (existing.trashed_at) {
				return jsonError(403, "Cannot publish to a trashed artifact");
			}
			artifactId = existing.id;
		} else {
			// Check artifact count limit
			const currentCount = await Artifacts.countArtifactsInSession(env.CANVAS_DB, session.id);
			if (currentCount >= MAX_ARTIFACTS_PER_SESSION) {
				return jsonError(413, `Session already has ${MAX_ARTIFACTS_PER_SESSION} artifacts`);
			}
			artifactId = crypto.randomUUID();
			isNewArtifact = true;
			await Artifacts.createArtifact(env.CANVAS_DB, artifactId, session.id, body.title.slice(0, 160));
		}

		// 8. Determine revision ordinal and IDs
		const ordinal = await Artifacts.nextRevisionOrdinal(env.CANVAS_DB, artifactId);
		const revisionId = crypto.randomUUID();
		const r2Key = `artifacts/${artifactId}/${revisionId}.html`;

		// 9. Create revision in D1 with status 'pending'
		await Artifacts.createRevision(env.CANVAS_DB, revisionId, artifactId, ordinal, r2Key, htmlBytes, "pending");

		try {
			// 10. Upload HTML to R2
			await env.CANVAS_ARTIFACTS.put(r2Key, body.html, {
				httpMetadata: { contentType: "text/html; charset=utf-8" },
			});

			// 11. Mark revision as 'ready'
			await Artifacts.updateRevisionStatus(env.CANVAS_DB, revisionId, "ready");

			// 12. Set as current revision
			await Artifacts.setCurrentRevision(env.CANVAS_DB, artifactId, revisionId);

			// 13. Touch session (extends expiry)
			await Sessions.touchSession(env.CANVAS_DB, session.id, ownerHash);

			// 14. Prune old revisions (keep latest N)
			await pruneOldRevisions(env, artifactId, r2Key);

			// 15. Broadcast update event via DO
			await broadcastUpdate(env, {
				type: isNewArtifact ? "artifact.created" : "artifact.updated",
				artifact_id: artifactId,
				revision_id: revisionId,
				session_id: session.id,
				timestamp: Math.floor(Date.now() / 1000),
			});

		} catch (err) {
			// Mark revision as failed
			await Artifacts.updateRevisionStatus(env.CANVAS_DB, revisionId, "failed").catch(() => {});
			throw err;
		}

		return jsonOk({
			ok: true,
			artifact_id: artifactId,
			revision_id: revisionId,
			ordinal,
			title: body.title,
			expires_at: session.expires_at,
			action: isNewArtifact ? "created" : "updated",
		});
	} catch (err) {
		if (err instanceof PublisherAuthError) {
			return authErrorToResponse(err);
		}
		throw err;
	}
}

/**
 * Prune revisions beyond the retention limit.
 * Only prunes READY revisions; leaves PENDING/FAILED for reconciliation.
 */
async function pruneOldRevisions(
	env: { CANVAS_DB: D1Database; CANVAS_ARTIFACTS: R2Bucket },
	artifactId: string,
	keepCurrentKey: string,
): Promise<void> {
	const excess = await Artifacts.selectOldestRevisions(env.CANVAS_DB, artifactId, MAX_REVISIONS_PER_ARTIFACT);
	if (excess.length === 0) return;

	// Only prune ready revisions
	const prunable = excess.filter((r) => r.status === "ready" && r.r2_key !== keepCurrentKey);
	if (prunable.length === 0) return;

	const idsToDelete = prunable.map((r) => r.id);
	const keysToDelete = prunable.map((r) => r.r2_key);

	// Delete R2 blobs (best-effort: never block prune on R2 failure)
	for (const key of keysToDelete) {
		try {
			await env.CANVAS_ARTIFACTS.delete(key);
		} catch {
			// Log and continue — cron reconciler will clean up
		}
	}

	// Delete D1 rows
	await Artifacts.deleteRevisions(env.CANVAS_DB, idsToDelete);
}

/**
 * Broadcast an update event to the session's Durable Object room.
 */
async function broadcastUpdate(
	env: { ARTIFACT_ROOM: DurableObjectNamespace },
	event: ArtifactUpdateEvent,
): Promise<void> {
	try {
		const roomId = env.ARTIFACT_ROOM.idFromName(`session:${event.session_id}`);
		const stub = env.ARTIFACT_ROOM.get(roomId);
		await stub.fetch("http://do/broadcast", {
			method: "POST",
			body: JSON.stringify(event),
			headers: { "content-type": "application/json" },
		});
	} catch {
		// Broadcast is best-effort; viewer will refresh on reconnect
	}
}
