/**
 * Telegram Canvas Worker — Entrypoint
 *
 * Routes:
 *   /api/*          — authenticated viewer API (Task 6)
 *   /internal/*     — publisher HMAC-gated API
 *   /scheduled/*    — cron triggers
 *   <other>         — static assets via Vite build
 *
 * Per the binding review, SPA fallback is NOT configured; the Worker
 * returns 404 for unknown non-API paths to avoid opaque error masking.
 */

import type { D1Database, R2Bucket, DurableObjectNamespace } from "@cloudflare/workers-types";
import { handlePublish } from "./routes/publish";
import type { ArtifactRoom } from "./durable/artifact-room";

export interface Env {
	CANVAS_DB: D1Database;
	CANVAS_ARTIFACTS: R2Bucket;
	ARTIFACT_ROOM: DurableObjectNamespace<ArtifactRoom>;
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

		if (path.startsWith("/api/")) {
			return handleApi(request, env, path);
		}

		if (path.startsWith("/internal/publish")) {
			return handlePublish(request, env);
		}

		return env.ASSETS.fetch(request);
	},

	async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
		// Cron maintenance: expiry, trash purge, nonce cleanup — added in Task 6
	},
};

async function handleApi(_request: Request, _env: Env, path: string): Promise<Response> {
	return new Response(JSON.stringify({ ok: true, path }), {
		headers: { "content-type": "application/json" },
	});
}

export { ArtifactRoom } from "./durable/artifact-room";
