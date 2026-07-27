/**
 * HTTP utility helpers for the Canvas Worker:
 *   - CSRF token generation and validation
 *   - Shell session cookie creation
 *   - Standard JSON responses
 *   - Security header defaults
 */

import { PublisherAuthError } from "../auth/publisher";

/** Default security headers applied to every API response. */
export const SECURITY_HEADERS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "private, no-store",
};

/**
 * Return a JSON error response with standard status codes.
 */
export function jsonError(status: number, message: string): Response {
	const statusText = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 413 ? "Payload Too Large" : "Error";
	return new Response(
		JSON.stringify({ error: message }),
		{
			status,
			statusText,
			headers: {
				...SECURITY_HEADERS,
				"content-type": "application/json; charset=utf-8",
			},
		},
	);
}

/**
 * Return a JSON success response.
 */
export function jsonOk(data: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			...SECURITY_HEADERS,
			"content-type": "application/json; charset=utf-8",
		},
	});
}

/**
 * Map known auth errors to HTTP responses.
 * Never echoes raw identifiers or credential material in the error message.
 */
export function authErrorToResponse(err: unknown): Response {
	if (err instanceof PublisherAuthError) {
		return jsonError(401, "Unauthorized");
	}
	if (err instanceof Error && err.message === "Missing init data") {
		return jsonError(401, "Unauthorized");
	}
	if (err instanceof Error && err.message === "Missing hash in init data") {
		return jsonError(401, "Unauthorized");
	}
	if (err instanceof Error && err.message === "Init data expired") {
		return jsonError(401, "Unauthorized");
	}
	if (err instanceof Error && err.message === "Invalid HMAC hash in init data") {
		return jsonError(403, "Forbidden");
	}
	if (err instanceof Error && (err.message.includes("exceeds maximum size"))) {
		return jsonError(413, "Payload Too Large");
	}
	return jsonError(500, "Internal Server Error");
}

/**
 * Generate a cryptographically random hex string for CSRF tokens.
 */
export function generateCsrfToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Create the Set-Cookie header for the shell session cookie.
 *
 * Per corrected auth model:
 *   Name: __Host-canvas_session
 *   Secure, HttpOnly, Path=/, SameSite=Lax
 *   No Domain attribute (required for __Host- prefix)
 *   Short expiration (1 hour)
 */
export function createSessionCookie(value: string, expiresAt: Date): string {
	return [
		`__Host-canvas_session=${value}`,
		"Secure",
		"HttpOnly",
		"Path=/",
		"SameSite=Lax",
		`Expires=${expiresAt.toUTCString()}`,
	].join("; ");
}

/**
 * Parse the shell session cookie value from a request's Cookie header.
 */
export function parseSessionCookie(request: Request): string | null {
	const cookieHeader = request.headers.get("Cookie") ?? "";
	for (const part of cookieHeader.split(";")) {
		const trimmed = part.trim();
		if (trimmed.startsWith("__Host-canvas_session=")) {
			return trimmed.slice("__Host-canvas_session=".length);
		}
	}
	return null;
}

/**
 * Verify the request's Origin header matches the expected origin.
 */
export function verifyOrigin(request: Request, expectedOrigin: string): boolean {
	const origin = request.headers.get("Origin");
	if (!origin) return false;
	return origin === expectedOrigin;
}

/**
 * Verify Sec-Fetch-Site header equals "same-origin".
 */
export function verifySameOrigin(request: Request): boolean {
	return request.headers.get("Sec-Fetch-Site") === "same-origin";
}
