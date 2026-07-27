/**
 * POST /api/auth/telegram — Shell login.
 *
 * Validates Telegram WebApp init data, derives the owner identity,
 * and issues a short-lived __Host-canvas_session cookie.
 *
 * Per corrected auth model:
 *   - No document tokens (removed)
 *   - Session cookie with Secure+HttpOnly+SameSite=Lax
 *   - Short expiration (1 hour), rotated on each login
 */

import type { D1Database } from "@cloudflare/workers-types";
import { validateTelegramInitData } from "../auth/telegram";
import { deriveOwnerHash } from "../auth/identity";
import { jsonError, createSessionCookie, SECURITY_HEADERS } from "../lib/http";

const SESSION_COOKIE_TTL_SECONDS = 3600; // 1 hour

export interface LoginEnv {
	CANVAS_DB: D1Database;
	TELEGRAM_BOT_TOKEN: string;
	IDENTITY_HMAC_KEY: string;
}

export async function handleTelegramAuth(
	request: Request,
	env: LoginEnv,
): Promise<Response> {
	try {
		const formData = await request.formData();
		const initData = formData.get("init_data") as string | null;

		if (!initData) {
			return jsonError(400, "Missing init_data");
		}

		// Validate Telegram WebApp init data
		const validated = await validateTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);

		// Derive identity
		const userId = String(validated.user.id);
		const ownerHash = await deriveOwnerHash(userId, env.IDENTITY_HMAC_KEY);

		// Issue session cookie
		const sessionId = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + SESSION_COOKIE_TTL_SECONDS * 1000);
		const cookieValue = `${sessionId}.${ownerHash.slice(0, 16)}`;

		return new Response(
			JSON.stringify({ ok: true, user: { id: validated.user.id, first_name: validated.user.first_name } }),
			{
				status: 200,
				headers: {
					...SECURITY_HEADERS,
					"content-type": "application/json; charset=utf-8",
					"set-cookie": createSessionCookie(cookieValue, expiresAt),
				},
			},
		);
	} catch (err) {
		if (err instanceof Error) {
			if (err.message.includes("Invalid HMAC") || err.message.includes("expired") || err.message.includes("Missing")) {
				return jsonError(401, "Unauthorized");
			}
		}
		return jsonError(500, "Internal Server Error");
	}
}

/**
 * Parse the owner hash from the session cookie.
 * Returns null if the cookie is missing or malformed.
 */
export function getOwnerFromCookie(request: Request): string | null {
	const cookieHeader = request.headers.get("Cookie") ?? "";
	for (const part of cookieHeader.split(";")) {
		const trimmed = part.trim();
		if (trimmed.startsWith("__Host-canvas_session=")) {
			const value = trimmed.slice("__Host-canvas_session=".length);
			const dot = value.indexOf(".");
			if (dot > 0) {
				return value.slice(dot + 1);
			}
		}
	}
	return null;
}
