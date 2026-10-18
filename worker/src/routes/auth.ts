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
import { deriveOwnerHash, importIdentityKey, hexToBytes, bytesToHex } from "../auth/identity";
import { jsonError, createSessionCookie, parseSessionCookie, SECURITY_HEADERS } from "../lib/http";

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
		const expires = Math.floor(Date.now() / 1000) + SESSION_COOKIE_TTL_SECONDS;
		const expiresAt = new Date(expires * 1000);
		const cookieValue = await signSessionCookieValue(ownerHash, env.IDENTITY_HMAC_KEY, expires);

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

const SESSION_COOKIE_DOMAIN = "canvas-session-cookie:";

/** Sign every session field in a domain distinct from identity derivation. */
export async function signSessionCookieValue(ownerHash: string, identityKey: string, expires: number): Promise<string> {
	const payload = `v1.${crypto.randomUUID()}.${ownerHash}.${expires}`;
	const key = await importIdentityKey(identityKey);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(SESSION_COOKIE_DOMAIN + payload));
	return `${payload}.${bytesToHex(new Uint8Array(signature))}`;
}

/** Return an owner only after validating the cookie's signature and server-side TTL. */
export async function getOwnerFromCookie(request: Request, identityKey: string): Promise<string | null> {
	const value = parseSessionCookie(request);
	if (!value) return null;
	const fields = /^v1\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.([a-f0-9]{64})\.([1-9][0-9]{0,15})\.([a-f0-9]{64})$/.exec(value);
	if (!fields) return null;
	const expires = Number(fields[3]);
	const now = Math.floor(Date.now() / 1000);
	if (!Number.isSafeInteger(expires) || expires <= now || expires > now + SESSION_COOKIE_TTL_SECONDS) return null;
	const key = await importIdentityKey(identityKey);
	const valid = await crypto.subtle.verify(
		"HMAC", key, hexToBytes(fields[4]),
		new TextEncoder().encode(SESSION_COOKIE_DOMAIN + value.slice(0, value.lastIndexOf("."))),
	);
	return valid ? fields[2] : null;
}
