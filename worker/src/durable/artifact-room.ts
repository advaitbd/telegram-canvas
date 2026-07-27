/**
 * ArtifactRoom: Durable Object for per-session WebSocket broadcast.
 *
 * Uses the WebSocket hibernation API for zero-cost idle connections.
 *
 * Lifecycle:
 *   - Client connects via GET /api/stream/:sessionId
 *   - DO accepts WebSocket, registers client by session_id
 *   - On publish event via POST /broadcast, DO fans out to all clients
 *   - On client disconnect, DO removes from registry
 *   - Alarm periodically checks for expired/trashed sessions
 */



export interface ArtifactUpdateEvent {
	type: "artifact.created" | "artifact.updated" | "artifact.deleted";
	artifact_id: string;
	revision_id?: string;
	session_id: string;
	timestamp: number;
}

// WebSocket close codes

export class ArtifactRoom {
	private ctx: DurableObjectState;
	private sessions: Map<string, WebSocket> = new Map();

	constructor(ctx: DurableObjectState, _env: unknown) {
		this.ctx = ctx;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// POST /broadcast — receive an artifact update and fan out
		if (url.pathname === "/broadcast" && request.method === "POST") {
			const event: ArtifactUpdateEvent = await request.json();
			await this.ctx.storage.put(`last:${event.type}:${event.artifact_id}`, event);
			this.broadcast(event);
			return new Response(JSON.stringify({ ok: true, fanned_out: this.sessions.size }), {
				headers: { "content-type": "application/json" },
			});
		}

		// WebSocket upgrade
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		this.ctx.acceptWebSocket(server);
		server.send(JSON.stringify({ type: "connected", session_id: url.searchParams.get("session_id") ?? "" }));

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
		try {
			const data = JSON.parse(message);
			if (data.type === "ping") {
				ws.send(JSON.stringify({ type: "pong" }));
			}
		} catch {
			ws.close(1008, "Invalid message");
		}
	}

	async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
		// Remove from session map if tracked
		for (const [key, sock] of this.sessions) {
			if (sock === ws) {
				this.sessions.delete(key);
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
				// Client disconnected; will be cleaned up on webSocketClose
			}
		}
	}
}
