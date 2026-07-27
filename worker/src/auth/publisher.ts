/**
 * Publisher HMAC authentication for /internal/publish requests.
 *
 * Signing format (per binding review amendment):
 *   v1\nPOST\n/internal/publish\n<key-id>\n<timestamp>\n<nonce>\n<sha256-hex-of-raw-body>
 *
 * Security properties:
 *   - HMAC-SHA256 with key rotation via key-id
 *   - Atomic nonce deduplication prevents replay within the TTL window
 *   - 5-minute clock skew tolerance
 *   - Fail-closed on duplicate nonce or missing headers
 *   - Supports one grace key during rotation so in-flight requests validate
 */

import type { D1Database } from "@cloudflare/workers-types";

const HMAC_ALG = "HMAC" as const;
const CANONICAL_PREFIX = "v1";
const METHOD = "POST";
const PATH = "/internal/publish";
const NONCE_TTL_SECONDS = 600; // 10 min — covers clock skew + retry window
const MAX_CLOCK_SKEW_SECONDS = 300; // 5 minutes
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB (must match limits.ts)

/** A parsed and verified publish claim. */
export interface PublishClaim {
	keyId: string;
	timestamp: number;
	nonce: string;
	bodySha256: string;
	rawBody: string;
}

/** Map of key-id → publisher secret hex. */
export type PublisherSecrets = Record<string, string>;

/** Extract the publisher signature headers from a request. */
export function extractPublisherHeaders(request: Request): {
	keyId: string;
	timestamp: number;
	nonce: string;
	signature: string;
} {
	const keyId = request.headers.get("x-canvas-key-id") ?? "";
	const timestampStr = request.headers.get("x-canvas-timestamp") ?? "";
	const nonce = request.headers.get("x-canvas-nonce") ?? "";
	const signature = request.headers.get("x-canvas-signature") ?? "";

	if (!keyId) throw new PublisherAuthError("Missing x-canvas-key-id header");
	if (!timestampStr) throw new PublisherAuthError("Missing x-canvas-timestamp header");
	if (!nonce) throw new PublisherAuthError("Missing x-canvas-nonce header");
	if (!signature) throw new PublisherAuthError("Missing x-canvas-signature header");

	const timestamp = parseInt(timestampStr, 10);
	if (Number.isNaN(timestamp)) {
		throw new PublisherAuthError("Invalid x-canvas-timestamp (not a number)");
	}

	return { keyId, timestamp, nonce, signature };
}

/**
 * Validate a publisher-signed request.
 *
 * @returns The verified PublishClaim on success
 * @throws {PublisherAuthError} On any validation failure
 */
export async function validatePublishRequest(
	request: Request,
	secrets: PublisherSecrets,
	db: D1Database,
): Promise<PublishClaim> {
	const { keyId, timestamp, nonce, signature } = extractPublisherHeaders(request);

	// 1. Resolve the secret for this key-id
	const secretHex = secrets[keyId];
	if (!secretHex) {
		throw new PublisherAuthError(`Unknown key-id: ${keyId}`);
	}

	// 2. Check clock skew
	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
		throw new PublisherAuthError("Timestamp outside allowed clock skew");
	}

	// 3. Check body size before reading
	const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
	if (contentLength > MAX_BODY_BYTES) {
		throw new PublisherAuthError("Request body exceeds maximum size");
	}

	// 4. Read body
	const bodyBytes = await request.clone().arrayBuffer();
	if (bodyBytes.byteLength > MAX_BODY_BYTES) {
		throw new PublisherAuthError("Request body exceeds maximum size");
	}

	// 5. Compute SHA-256 of body
	const bodySha256 = await sha256Hex(bodyBytes);

	// 6. Build the canonical string
	const canonicalString = [
		CANONICAL_PREFIX,
		METHOD,
		PATH,
		keyId,
		String(timestamp),
		nonce,
		bodySha256,
	].join("\n");

	// 7. Verify HMAC
	const expectedSig = await computeHmacHex(secretHex, canonicalString);
	if (!constantTimeEqual(signature, expectedSig)) {
		throw new PublisherAuthError("Invalid signature");
	}

	// 8. Check nonce uniqueness (atomic insert into D1)
	const inserted = await insertNonce(db, nonce, now + NONCE_TTL_SECONDS);
	if (!inserted) {
		throw new PublisherAuthError("Nonce already used");
	}

	// 9. Decode body as text
	const rawBody = new TextDecoder().decode(bodyBytes);

	return {
		keyId,
		timestamp,
		nonce,
		bodySha256,
		rawBody,
	};
}

/**
 * Insert a nonce into the D1 nonce table.
 * Returns true if the nonce was inserted (first use), false if it already exists.
 * The nonce table has TTL via expires_at column; stale entries are cleaned by cron.
 */
async function insertNonce(
	db: D1Database,
	nonce: string,
	expiresAt: number,
): Promise<boolean> {
	try {
		const result = await db
			.prepare(
				"INSERT INTO publisher_nonces (nonce, expires_at) VALUES (?, ?)",
			)
			.bind(nonce, expiresAt)
			.run();
		return result.meta.changes > 0;
	} catch {
		// UNIQUE constraint violation — nonce already exists
		return false;
	}
}

/**
 * Compute HMAC-SHA256 of a string with a hex-encoded key.
 */
async function computeHmacHex(secretHex: string, data: string): Promise<string> {
	const keyBytes = hexToBytes(secretHex);
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: HMAC_ALG, hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		HMAC_ALG,
		cryptoKey,
		new TextEncoder().encode(data),
	);
	return bytesToHex(new Uint8Array(sig));
}

/**
 * Compute SHA-256 hex digest of binary data.
 */
async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", data);
	return bytesToHex(new Uint8Array(hash));
}

/**
 * Constant-time hex string comparison.
 */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class PublisherAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PublisherAuthError";
	}
}
