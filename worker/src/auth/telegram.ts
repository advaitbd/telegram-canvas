/**
 * Telegram WebApp init-data validation.
 *
 * Verifies the HMAC-SHA256 signature of Telegram Mini App init data
 * using the bot token as specified by Telegram's Bot API documentation.
 * Only the server-side `TELEGRAM_BOT_TOKEN` Worker secret is used.
 *
 * Never trusts `initDataUnsafe` from the client — always re-validates.
 */

const TELEGRAM_HMAC_ALG = "HMAC" as const;
const TELEGRAM_INIT_DATA_SECRET_PREFIX = "WebAppData" as const;

/** Parsed and validated Telegram user from init data. */
export interface TelegramUser {
	id: number;
	first_name: string;
	last_name?: string;
	username?: string;
	language_code?: string;
	is_premium?: boolean;
}

/** The payload extracted from validated init data. */
export interface ValidatedInitData {
	user: TelegramUser;
	chat_id?: number;
	chat_type?: string;
	auth_date: number;
	query_id?: string;
	start_param?: string;
}

/**
 * Derive the HMAC secret used to sign init data.
 *
 * Per Telegram spec: HMAC-SHA256(WebAppData, bot_token)
 */
async function deriveInitDataSecret(botToken: string): Promise<CryptoKey> {
	const key = new TextEncoder().encode(TELEGRAM_INIT_DATA_SECRET_PREFIX);
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key,
		{ name: TELEGRAM_HMAC_ALG, hash: "SHA-256" },
		false,
		["sign"],
	);
	// Sign the bot token with the WebAppData key to get the derived secret
	const sig = await crypto.subtle.sign(
		TELEGRAM_HMAC_ALG,
		cryptoKey,
		new TextEncoder().encode(botToken),
	);
	// Import the derived bytes as a new HMAC key
	return crypto.subtle.importKey(
		"raw",
		sig,
		{ name: TELEGRAM_HMAC_ALG, hash: "SHA-256" },
		false,
		["sign"],
	);
}

/**
 * Constant-time comparison of two hex strings.
 * Returns true when both strings are identical.
 */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

/**
 * Validate Telegram WebApp init data.
 *
 * @param initData - The raw query string from `window.Telegram.WebApp.initData`
 * @param botToken - The TELEGRAM_BOT_TOKEN Worker secret
 * @param maxAgeSeconds - Maximum allowed age in seconds (default 86400 = 24h)
 * @returns The validated init data payload
 * @throws {Error} If validation fails
 */
export async function validateTelegramInitData(
	initData: string,
	botToken: string,
	maxAgeSeconds = 86400,
): Promise<ValidatedInitData> {
	if (!initData || typeof initData !== "string") {
		throw new Error("Missing init data");
	}

	// Parse query string
	const params = new URLSearchParams(initData);
	const hash = params.get("hash");
	if (!hash) {
		throw new Error("Missing hash in init data");
	}

	// Extract auth_date
	const authDateStr = params.get("auth_date");
	if (!authDateStr) {
		throw new Error("Missing auth_date in init data");
	}
	const authDate = parseInt(authDateStr, 10);
	if (Number.isNaN(authDate)) {
		throw new Error("Invalid auth_date");
	}

	// Check expiry
	const now = Math.floor(Date.now() / 1000);
	if (now - authDate > maxAgeSeconds) {
		throw new Error("Init data expired");
	}

	// Build the data check string per Telegram spec:
	// Sort all key=value pairs (excluding hash) alphabetically by key,
	// then join with \n
	const pairs: string[] = [];
	for (const [key, value] of params.entries()) {
		if (key !== "hash") {
			pairs.push(`${key}=${value}`);
		}
	}
	pairs.sort();
	const checkString = pairs.join("\n");

	// Verify HMAC
	const secret = await deriveInitDataSecret(botToken);
	const encoder = new TextEncoder();
	const signature = await crypto.subtle.sign(
		TELEGRAM_HMAC_ALG,
		secret,
		encoder.encode(checkString),
	);

	// Convert signature to hex
	const sigArray = new Uint8Array(signature);
	const computedHash = Array.from(sigArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	if (!constantTimeEqual(computedHash, hash)) {
		throw new Error("Invalid HMAC hash in init data");
	}

	// Parse user
	const userStr = params.get("user");
	if (!userStr) {
		throw new Error("Missing user in init data");
	}
	let user: TelegramUser;
	try {
		user = JSON.parse(userStr);
	} catch {
		throw new Error("Invalid user JSON in init data");
	}
	if (!user.id || typeof user.id !== "number") {
		throw new Error("Invalid user.id in init data");
	}

	return {
		user,
		chat_id: params.has("chat_id") ? parseInt(params.get("chat_id")!, 10) : undefined,
		chat_type: params.get("chat_type") || undefined,
		auth_date: authDate,
		query_id: params.get("query_id") || undefined,
		start_param: params.get("start_param") || undefined,
	};
}
