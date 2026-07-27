/**
 * ArtifactRoom: Durable Object for per-session WebSocket broadcast.
 *
 * Uses the WebSocket hibernation API for zero-cost idle connections.
 * Enforces connection caps from rate-limits module.
 */

import { tryAcquireWsSlot, releaseWsSlot } from "../lib/rate-limits";

export interface ArtifactUpdateEvent {
	type: "artifact.created" | "artifact.updated" | "artifact.deleted";
	artifact_id: string;
	revision_id?: string;
	session_id: string;
	timestamp: number;
}

const CLOSE_POLICY = 1008;

export class ArtifactRoom {
	private ctx: DurableObjectState;
	private sessions: Map<string, WebSocket> = new Map();

	constructor(ctx: DurableObjectState, _env: unknown) {
		this.ctx = ctx;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/broadcast" && request.method === "POST") {
			const event: ArtifactUpdateEvent = await request.json();
			await this.ctx.storage.put(`last:${event.type}:${event.artifact_id}`, event);
			this.broadcast(event);
			return new Response(JSON.stringify({ ok: true, fanned_out: this.sessions.size }), {
				headers: { "content-type": "application/json" },
			});
		}

		const sessionId = url.searchParams.get("session_id") ?? "unknown";
		if (!tryAcquireWsSlot(sessionId)) {
			return new Response("Connection limit reached", { status: 503 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		server.send(JSON.stringify({ type: "connected", session_id: sessionId }));
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
		try {
			const data = JSON.parse(message);
			if (data.type === "ping") {
				ws.send(JSON.stringify({ type: "pong" }));
			}
		} catch {
			ws.close(CLOSE_POLICY, "Invalid message");
		}
	}

	async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
		for (const [key, sock] of this.sessions) {
			if (sock === ws) {
				this.sessions.delete(key);
				releaseWsSlot(key);
				break;
			}
		}
	}

	private broadcast(event: ArtifactUpdateEvent): void {
		const message = JSON.stringify({ type: "artifact_update", data: event });
		for (const [_, ws] of this.sessions) {
			try {
				ws.send(message);
			} catch {
				// Client disconnected; cleaned up on webSocketClose
			}
		}
	}
}
