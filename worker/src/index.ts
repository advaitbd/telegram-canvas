/**
 * Telegram Canvas Worker — Entrypoint
 *
 * Routes:
 *   POST /api/auth/telegram         — Shell login (init-data validation)
 *   GET  /api/sessions              — List owner sessions
 *   GET  /api/sessions/:id/artifacts — List artifacts in session
 *   GET  /api/artifacts/:id         — Get artifact metadata
 *   GET  /api/artifacts/:id/revisions — List revisions
 *   GET  /api/artifacts/:id/revisions/:revId/document — Serve HTML blob
 *   GET  /api/artifacts/:id/download — Download current revision
 *   POST /api/artifacts/:id/extend   — Extend session expiry (CSRF)
 *   DELETE /api/artifacts/:id        — Trash artifact (CSRF)
 *   GET  /api/stream/:sessionId      — WebSocket stream
 *   POST /internal/publish           — Publisher HMAC-gated publish
 *   GET/POST <other>                 — Static assets (Vite build)
 *   Scheduled()                      — Daily maintenance cron
 */

import type { D1Database, R2Bucket, DurableObjectNamespace } from "@cloudflare/workers-types";
import { handlePublish } from "./routes/publish";
import { handleTelegramAuth } from "./routes/auth";
import { handleListSessions, handleListArtifacts } from "./routes/sessions";
import {
	handleGetArtifact, handleListRevisions, handleGetDocument,
	handleDownload, handleExtend, handleTrash,
} from "./routes/artifacts";
import { handleStream } from "./routes/stream";
import { handleMaintenance } from "./routes/maintenance";
import { handleCreateShare, handlePublicDocument, handlePublicShare, handleRevokeShare } from "./routes/shares";

export interface Env {
	CANVAS_DB: D1Database;
	CANVAS_ARTIFACTS: R2Bucket;
	ARTIFACT_ROOM: DurableObjectNamespace;
	TELEGRAM_BOT_TOKEN: string;
	PUBLISHER_SECRET: string;
	IDENTITY_HMAC_KEY: string;
	DOCUMENT_TOKEN_KEY: string;
	ENVIRONMENT: string;
	ASSETS: Fetcher;
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		// ── Viewer API ──────────────────────────────────────────────
		if (path === "/api/auth/telegram" && method === "POST") {
			return handleTelegramAuth(request, env);
		}

		if (path === "/api/sessions" && method === "GET") {
			return handleListSessions(request, env.CANVAS_DB);
		}

		// /api/sessions/:id/artifacts
		const sessionsMatch = path.match(/^\/api\/sessions\/([^/]+)\/artifacts$/);
		if (sessionsMatch && method === "GET") {
			return handleListArtifacts(request, env.CANVAS_DB, sessionsMatch[1]);
		}

		// /api/artifacts/:id
		const artGetMatch = path.match(/^\/api\/artifacts\/([^/]+)$/);
		if (artGetMatch && method === "GET") {
			return handleGetArtifact(request, env.CANVAS_DB, artGetMatch[1]);
		}

		// /api/artifacts/:id/revisions/:revId/document
		const docMatch = path.match(/^\/api\/artifacts\/([^/]+)\/revisions\/([^/]+)\/document$/);
		if (docMatch && method === "GET") {
			return handleGetDocument(request, env, docMatch[1], docMatch[2]);
		}

		// /api/artifacts/:id/revisions
		const revMatch = path.match(/^\/api\/artifacts\/([^/]+)\/revisions$/);
		if (revMatch && method === "GET") {
			return handleListRevisions(request, env.CANVAS_DB, revMatch[1]);
		}

		// /api/artifacts/:id/download
		const dlMatch = path.match(/^\/api\/artifacts\/([^/]+)\/download$/);
		if (dlMatch && method === "GET") {
			return handleDownload(request, env, dlMatch[1]);
		}

		// /api/artifacts/:id/extend
		const extMatch = path.match(/^\/api\/artifacts\/([^/]+)\/extend$/);
		if (extMatch && method === "POST") {
			return handleExtend(request, env.CANVAS_DB, extMatch[1]);
		}

		// DELETE /api/artifacts/:id
		const trashMatch = path.match(/^\/api\/artifacts\/([^/]+)$/);
		if (trashMatch && method === "DELETE") {
			return handleTrash(request, env.CANVAS_DB, trashMatch[1]);
		}

		const shareCreateMatch = path.match(/^\/api\/artifacts\/([^/]+)\/shares$/);
		if (shareCreateMatch && method === "POST") return handleCreateShare(request, env.CANVAS_DB, shareCreateMatch[1]);
		const shareRevokeMatch = path.match(/^\/api\/artifacts\/([^/]+)\/shares\/([a-f0-9]{48})$/);
		if (shareRevokeMatch && method === "DELETE") return handleRevokeShare(request, env.CANVAS_DB, shareRevokeMatch[1], shareRevokeMatch[2]);

		// /api/stream/:sessionId
		const streamMatch = path.match(/^\/api\/stream\/([^/]+)$/);
		if (streamMatch) {
			return handleStream(request, env, streamMatch[1]);
		}

		// Fallthrough for unmatched /api/ paths (health check etc.)
		if (path.startsWith("/api/")) {
			return handleApi(request, env, path);
		}

		// ── Publisher API ───────────────────────────────────────────
		if (path.startsWith("/internal/publish")) {
			return handlePublish(request, env);
		}

		const publicDocumentMatch = path.match(/^\/s\/([a-f0-9]{48})\/document$/);
		if (publicDocumentMatch && method === "GET") return handlePublicDocument(env.CANVAS_DB, env.CANVAS_ARTIFACTS, publicDocumentMatch[1]);
		const publicShareMatch = path.match(/^\/s\/([a-f0-9]{48})$/);
		if (publicShareMatch && method === "GET") return handlePublicShare(request, env.CANVAS_DB, publicShareMatch[1]);

		// ── Static assets ───────────────────────────────────────────
		return env.ASSETS.fetch(request);
	},

	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		await handleMaintenance(env);
	},
};


async function handleApi(_request: Request, _env: Env, path: string): Promise<Response> {
	return new Response(JSON.stringify({ ok: true, path }), {
		headers: { "content-type": "application/json" },
	});
}
export { ArtifactRoom } from "./durable/artifact-room";
