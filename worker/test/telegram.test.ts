/**
 * Telegram init-data validation tests.
 *
 * Tests follow TDD: write failing cases first, then implement.
 *
 * Coverage:
 *  - Valid init data → passes, returns user payload
 *  - Invalid HMAC hash → rejected
 *  - Stale auth_date → rejected
 *  - Malformed query (no hash) → rejected
 *  - Absent user field → rejected
 *  - Empty init data → rejected
 */

import { describe, it, expect } from "vitest";

// We test the implementation directly (pure function, no D1 needed).
// Uses a real bot token and a computed valid init data string.

const BOT_TOKEN = "1234567890:ABCdefGHIjklmNOPqrstUVwxyz-1234567890";

/**
 * Build a valid init data string with a known HMAC.
 * The test bot token above is synthetic; the algorithm matches Telegram's spec.
 * This lets us test with KNOWN VALID data and KNOWN INVALID variants.
 */
async function buildValidInitData(overrides?: Record<string, string>): Promise<string> {
	const params = new URLSearchParams();
	params.set("query_id", overrides?.query_id ?? "AAHxGgIAAAAAADGgAgC");
	params.set("user", overrides?.user ?? JSON.stringify({
		id: 123456789,
		first_name: "Test",
		last_name: "User",
		username: "testuser",
		language_code: "en",
	}));
	params.set("auth_date", overrides?.auth_date ?? String(Math.floor(Date.now() / 1000)));

	// When hash is overridden, skip computation (caller wants an invalid hash)
	if (overrides?.hash) {
		params.set("hash", overrides.hash);
		return params.toString();
	}

	if (overrides?.extra_key) {
		params.set(overrides.extra_key, overrides.extra_value ?? "");
	}

	// Compute the correct HMAC-SHA256 hash using Telegram's algorithm
	const encoder = new TextEncoder();
	const webAppKey = "WebAppData";
	const key1 = await crypto.subtle.importKey(
		"raw", encoder.encode(webAppKey),
		{ name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);
	const derived = await crypto.subtle.sign("HMAC", key1, encoder.encode(BOT_TOKEN));
	const hmacKey = await crypto.subtle.importKey(
		"raw", derived,
		{ name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);

	// Build check string (sorted key=value, excluding hash)
	const checkPairs: string[] = [];
	for (const [k, v] of params.entries()) {
		if (k !== "hash") checkPairs.push(`${k}=${v}`);
	}
	checkPairs.sort();
	const checkString = checkPairs.join("\n");

	const sig = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(checkString));
	const hash = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	params.set("hash", hash);
	return params.toString();
}

describe("Telegram init-data validation", () => {
	it("accepts valid init data and returns user payload", async () => {
		const initData = await buildValidInitData();
		const { validateTelegramInitData } = await import("../src/auth/telegram");
		const result = await validateTelegramInitData(initData, BOT_TOKEN);

		expect(result.user.id).toBe(123456789);
		expect(result.user.first_name).toBe("Test");
		expect(result.auth_date).toBeGreaterThan(0);
		expect(result.query_id).toBe("AAHxGgIAAAAAADGgAgC");
	});

	it("rejects init data with invalid HMAC hash", async () => {
		const initData = await buildValidInitData({ hash: "0000000000000000000000000000000000000000000000000000000000000000" });
		const { validateTelegramInitData } = await import("../src/auth/telegram");
		await expect(validateTelegramInitData(initData, BOT_TOKEN)).rejects.toThrow("Invalid HMAC hash");
	});

	it("rejects init data with stale auth_date (older than 24h)", async () => {
		const oldDate = String(Math.floor(Date.now() / 1000) - 90000); // 25 hours
		const initData = await buildValidInitData({ auth_date: oldDate });
		const { validateTelegramInitData } = await import("../src/auth/telegram");
		await expect(validateTelegramInitData(initData, BOT_TOKEN)).rejects.toThrow("expired");
	});

	it("rejects init data with no hash parameter", async () => {
		const { validateTelegramInitData } = await import("../src/auth/telegram");
		await expect(
			validateTelegramInitData("user=%7B%22id%22%3A1%7D&auth_date=1000000", BOT_TOKEN),
		).rejects.toThrow("Missing hash");
	});

	it("rejects init data with no user field", async () => {
		const { validateTelegramInitData } = await import("../src/auth/telegram");
		const params = new URLSearchParams();
		params.set("query_id", "q1");
		params.set("auth_date", String(Math.floor(Date.now() / 1000)));

		// Compute a valid-looking hash (will fail on user check)
		const encoder = new TextEncoder();
		const key1 = await crypto.subtle.importKey(
			"raw", encoder.encode("WebAppData"),
			{ name: "HMAC", hash: "SHA-256" }, false, ["sign"],
		);
		const derived = await crypto.subtle.sign("HMAC", key1, encoder.encode(BOT_TOKEN));
		const hmacKey = await crypto.subtle.importKey(
			"raw", derived,
			{ name: "HMAC", hash: "SHA-256" }, false, ["sign"],
		);

		const pairs = ["auth_date=" + params.get("auth_date"), "query_id=q1"];
		pairs.sort();
		const sig = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(pairs.join("\n")));
		const hash = Array.from(new Uint8Array(sig))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		params.set("hash", hash);

		await expect(
			validateTelegramInitData(params.toString(), BOT_TOKEN),
		).rejects.toThrow("Missing user");
	});

	it("rejects init data with non-numeric user.id", async () => {
		const initData = await buildValidInitData({
			user: JSON.stringify({ id: "not_a_number", first_name: "X" }),
		});
		const { validateTelegramInitData } = await import("../src/auth/telegram");
		await expect(validateTelegramInitData(initData, BOT_TOKEN)).rejects.toThrow("Invalid user.id");
	});

	it("rejects empty or missing init data", async () => {
		const { validateTelegramInitData } = await import("../src/auth/telegram");
		await expect(validateTelegramInitData("", BOT_TOKEN)).rejects.toThrow("Missing init data");
	});
});
