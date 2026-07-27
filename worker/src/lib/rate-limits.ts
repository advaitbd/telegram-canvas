/**
 * Rate limiting and connection cap utilities.
 *
 * Rate limits are stored in D1 using a sliding-window counter.
 * Connection caps are enforced in the Durable Object.
 */

import type { D1Database } from "@cloudflare/workers-types";

// ── Rate limits ───────────────────────────────────────────────────────

/** Maximum publish requests per owner per hour. */
export const PUBLISH_RATE_PER_OWNER_HOUR = 60;

/** Maximum publish requests per session per minute. */
export const PUBLISH_RATE_PER_SESSION_MINUTE = 10;

/** Maximum API requests per owner per minute (shell auth, list, etc.). */
export const API_RATE_PER_OWNER_MINUTE = 120;

/** Maximum WebSocket connections per session. */
export const WEBSOCKET_CAP_PER_SESSION = 32;

/** Maximum total WebSocket connections across all sessions. */
export const WEBSOCKET_CAP_TOTAL = 256;

// ── In-memory rate state ──────────────────────────────────────────────
// Simple in-memory counters for connection caps (per-worker, best-effort).
// Persisted rate limits use D1.

const wsConnectionCounts = new Map<string, number>();
let totalWsConnections = 0;

/** Track a new WebSocket connection. Returns false if cap exceeded. */
export function tryAcquireWsSlot(sessionId: string): boolean {
	if (totalWsConnections >= WEBSOCKET_CAP_TOTAL) return false;
	const current = wsConnectionCounts.get(sessionId) ?? 0;
	if (current >= WEBSOCKET_CAP_PER_SESSION) return false;
	wsConnectionCounts.set(sessionId, current + 1);
	totalWsConnections++;
	return true;
}

/** Release a WebSocket connection slot. */
export function releaseWsSlot(sessionId: string): void {
	const current = wsConnectionCounts.get(sessionId) ?? 0;
	if (current > 0) {
		wsConnectionCounts.set(sessionId, current - 1);
		totalWsConnections--;
	}
}

/** Check publish rate limit for an owner. Returns true if allowed. */
export async function checkOwnerPublishRate(
	db: D1Database,
	ownerHash: string,
): Promise<boolean> {
	const windowStart = Math.floor(Date.now() / 1000) - 3600; // 1 hour window
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS cnt FROM publisher_rate_limits
       WHERE owner_hash = ? AND window_start > ?`,
		)
		.bind(ownerHash, windowStart)
		.first<{ cnt: number }>();
	return (row?.cnt ?? 0) < PUBLISH_RATE_PER_OWNER_HOUR;
}

/** Check publish rate limit for a session. Returns true if allowed. */
export async function checkSessionPublishRate(
	db: D1Database,
	sessionId: string,
): Promise<boolean> {
	const windowStart = Math.floor(Date.now() / 1000) - 60; // 1 minute window
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS cnt FROM publisher_rate_limits
       WHERE session_id = ? AND window_start > ?`,
		)
		.bind(sessionId, windowStart)
		.first<{ cnt: number }>();
	return (row?.cnt ?? 0) < PUBLISH_RATE_PER_SESSION_MINUTE;
}

/** Record a publish attempt for rate limiting. */
export async function recordPublishAttempt(
	db: D1Database,
	ownerHash: string,
	sessionId: string,
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await db
		.prepare(
			"INSERT INTO publisher_rate_limits (owner_hash, session_id, window_start) VALUES (?, ?, ?)",
		)
		.bind(ownerHash, sessionId, now)
		.run();
}
