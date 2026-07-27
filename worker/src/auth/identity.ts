/**
 * Pseudonymous identity hashing for Canvas.
 *
 * Derives deterministic owner_hash and session_hash values using
 * an identity HMAC key and domain-separated input strings.
 *
 * The resulting hashes are stored in D1 in place of raw Telegram user IDs
 * or Hermes session IDs, so a D1 breach does not reveal platform identities.
 *
 * Domain separation prevents cross-domain hash confusion:
 *   - owner_hash  = HMAC(identity_key, "telegram-owner:<user_id>")
 *   - session_hash = HMAC(identity_key, "hermes-session:<session_id>")
 */

const HMAC_ALG = "HMAC" as const;
const DOMAIN_OWNER = "telegram-owner:";
const DOMAIN_SESSION = "hermes-session:";

/**
 * Import a raw hex key into a CryptoKey for HMAC-SHA256.
 */
async function importIdentityKey(keyHex: string): Promise<CryptoKey> {
	const raw = hexToBytes(keyHex);
	return crypto.subtle.importKey(
		"raw",
		raw,
		{ name: HMAC_ALG, hash: "SHA-256" },
		false,
		["sign"],
	);
}

/**
 * Compute HMAC-SHA256 and return the hex digest.
 */
async function hmacHex(key: CryptoKey, data: Uint8Array): Promise<string> {
	const sig = await crypto.subtle.sign(HMAC_ALG, key, data);
	return bytesToHex(new Uint8Array(sig));
}

/**
 * Derive a deterministic owner hash from a raw Telegram user ID.
 *
 * @param userId - The raw Telegram user ID (e.g. "123456789")
 * @param identityKeyHex - The IDENTITY_HMAC_KEY hex string
 * @returns Hex-encoded SHA-256 HMAC digest
 */
export async function deriveOwnerHash(
	userId: string,
	identityKeyHex: string,
): Promise<string> {
	const key = await importIdentityKey(identityKeyHex);
	const input = DOMAIN_OWNER + userId;
	return hmacHex(key, new TextEncoder().encode(input));
}

/**
 * Derive a deterministic session hash from a Hermes session ID.
 *
 * @param sessionId - The Hermes session UUID (e.g. "20260726_abc123")
 * @param identityKeyHex - The IDENTITY_HMAC_KEY hex string
 * @returns Hex-encoded SHA-256 HMAC digest
 */
export async function deriveSessionHash(
	sessionId: string,
	identityKeyHex: string,
): Promise<string> {
	const key = await importIdentityKey(identityKeyHex);
	const input = DOMAIN_SESSION + sessionId;
	return hmacHex(key, new TextEncoder().encode(input));
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
