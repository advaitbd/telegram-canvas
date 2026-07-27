/**
 * ArtifactRoom: Durable Object for per-session update broadcast.
 *
 * In Task 6 this is extended with WebSocket hibernation for live viewers.
 * For Task 5 it provides a simple fetch-based event bus:
 *   POST /broadcast  — send an artifact.updated event to the room
 *   GET /            — health check
 *
 * The room is addressed by session_id so all viewers of the same
 * session share one room.
 */

import type { D1Database } from "@cloudflare/workers-types";

/** Event payload for artifact updates. */
export interface ArtifactUpdateEvent {
	type: "artifact.created" | "artifact.updated" | "artifact.deleted";
	artifact_id: string;
	revision_id?: string;
	session_id: string;
	timestamp: number;
}

export class ArtifactRoom {
	private ctx: DurableObjectState;

	constructor(ctx: DurableObjectState, _env: unknown) {
		this.ctx = ctx;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/broadcast" && request.method === "POST") {
			const event: ArtifactUpdateEvent = await request.json();
			// Store the latest event in DO storage for replay to new WebSocket clients
			await this.ctx.storage.put(`last:${event.type}:${event.artifact_id}`, event);
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
			});
		}

		return new Response(JSON.stringify({ room: "active" }), {
			headers: { "content-type": "application/json" },
		});
	}
}
