/**
 * Publisher HMAC authentication tests.
 *
 * Tests follow TDD: write failing cases first, then implement.
 *
 * Coverage:
 *  - Valid HMAC with correct canonical string → passes
 *  - Invalid HMAC (modified body) → 401
 *  - Stale timestamp (>5 min) → 401
 *  - Reused nonce → second attempt fails
 *  - Missing required headers → 401
 *  - Unknown key-id → 401
 *  - Oversized content (>5 MiB) → 413
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		CANVAS_DB: D1Database;
	}
}

const TEST_SECRET_1 = "ab" + "cd".repeat(31); // 64 hex chars = 32 bytes
const TEST_SECRET_2 = "ef" + "01".repeat(31); // different key for rotation
const PUBLISHER_SECRETS = { "key1": TEST_SECRET_1, "key2": TEST_SECRET_2 };

/**
 * Build a valid signed request for testing.
 */
async function buildSignedRequest(
	body: string,
	keyId: string,
	secretHex: string,
	overrides?: { timestamp?: number; nonce?: string; method?: string; path?: string },
): Promise<Request> {
	const encoder = new TextEncoder();
	const timestamp = overrides?.timestamp ?? Math.floor(Date.now() / 1000);
	const nonce = overrides?.nonce ?? crypto.randomUUID();
	const bodySha256 = await sha256Hex(encoder.encode(body));

	const canonical = [
		"v1",
		overrides?.method ?? "POST",
		overrides?.path ?? "/internal/publish",
		keyId,
		String(timestamp),
		nonce,
		bodySha256,
	].join("\n");

	const sig = await computeHmacHex(secretHex, canonical);

	const url = `https://canvas.advaitdeshpande.com${overrides?.path ?? "/internal/publish"}`;
	const req = new Request(url, {
		method: overrides?.method ?? "POST",
		headers: {
			"content-type": "application/json",
			"x-canvas-key-id": keyId,
			"x-canvas-timestamp": String(timestamp),
			"x-canvas-nonce": nonce,
			"x-canvas-signature": sig,
		},
		body,
	});
	return req;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function computeHmacHex(secretHex: string, data: string): Promise<string> {
	const keyBytes = new Uint8Array(secretHex.length / 2);
	for (let i = 0; i < secretHex.length; i += 2) {
		keyBytes[i / 2] = parseInt(secretHex.slice(i, i + 2), 16);
	}
	const cryptoKey = await crypto.subtle.importKey(
		"raw", keyBytes,
		{ name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

describe("Publisher HMAC authentication", () => {
	let db: D1Database;

	beforeAll(async () => {
		db = env.CANVAS_DB;
		await db.prepare(
			"CREATE TABLE IF NOT EXISTS publisher_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
		).run();
		await db.prepare(
			"CREATE INDEX IF NOT EXISTS idx_nonce_expires ON publisher_nonces(expires_at)",
		).run().catch(() => {}); // index may already exist
	});

	it("accepts a valid signed request", async () => {
		const { validatePublishRequest } = await import("../src/auth/publisher");
		const body = JSON.stringify({ title: "test", html: "<p>hello</p>" });
		const req = await buildSignedRequest(body, "key1", TEST_SECRET_1);

		const claim = await validatePublishRequest(req, PUBLISHER_SECRETS, db);
		expect(claim.keyId).toBe("key1");
		expect(claim.bodySha256).toBeTruthy();
		expect(claim.rawBody).toBe(body);
	});

	it("accepts request signed with a rotated key (key2)", async () => {
		const { validatePublishRequest } = await import("../src/auth/publisher");
		const body = JSON.stringify({ title: "rotated", html: "<p>key2</p>" });
		const req = await buildSignedRequest(body, "key2", TEST_SECRET_2);

		const claim = await validatePublishRequest(req, PUBLISHER_SECRETS, db);
		expect(claim.keyId).toBe("key2");
	});

	it("rejects request with invalid HMAC (modified body)", async () => {
		const { validatePublishRequest, PublisherAuthError } = await import("../src/auth/publisher");
		const body = JSON.stringify({ title: "original", html: "<p>hello</p>" });
		const req = await buildSignedRequest(body, "key1", TEST_SECRET_1);

		// Modify the body after signing (simulate a man-in-the-middle)
		const modifiedReq = new Request(req.url, {
			method: req.method,
			headers: req.headers,
			body: JSON.stringify({ title: "modified", html: "<p>evil</p>" }),
		});

		await expect(
			validatePublishRequest(modifiedReq, PUBLISHER_SECRETS, db),
		).rejects.toThrow(PublisherAuthError);
	});

	it("rejects request with stale timestamp (>5 min)", async () => {
		const { validatePublishRequest, PublisherAuthError } = await import("../src/auth/publisher");
		const oldTs = Math.floor(Date.now() / 1000) - 400; // 6.7 minutes ago
		const body = JSON.stringify({ title: "stale", html: "<p>old</p>" });
		const req = await buildSignedRequest(body, "key1", TEST_SECRET_1, { timestamp: oldTs });

		await expect(
			validatePublishRequest(req, PUBLISHER_SECRETS, db),
		).rejects.toThrow(PublisherAuthError);
	});

	it("rejects reused nonce (replay attack)", async () => {
		const { validatePublishRequest, PublisherAuthError } = await import("../src/auth/publisher");
		const reusedNonce = crypto.randomUUID();
		const body = JSON.stringify({ title: "replay", html: "<p>test</p>" });

		const req1 = await buildSignedRequest(body, "key1", TEST_SECRET_1, { nonce: reusedNonce });
		await validatePublishRequest(req1, PUBLISHER_SECRETS, db); // first use — OK

		const req2 = await buildSignedRequest(body, "key1", TEST_SECRET_1, { nonce: reusedNonce });
		await expect(
			validatePublishRequest(req2, PUBLISHER_SECRETS, db),
		).rejects.toThrow(PublisherAuthError);
	});

	it("rejects request with missing headers", async () => {
		const { validatePublishRequest, PublisherAuthError } = await import("../src/auth/publisher");
		const req = new Request("https://canvas.advaitdeshpande.com/internal/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});

		await expect(
			validatePublishRequest(req, PUBLISHER_SECRETS, db),
		).rejects.toThrow(PublisherAuthError);
	});

	it("rejects request with unknown key-id", async () => {
		const { validatePublishRequest, PublisherAuthError } = await import("../src/auth/publisher");
		const body = JSON.stringify({ title: "x", html: "<p>x</p>" });
		const req = await buildSignedRequest(body, "unknown-key", TEST_SECRET_1);

		await expect(
			validatePublishRequest(req, PUBLISHER_SECRETS, db),
		).rejects.toThrow(PublisherAuthError);
	});

	it("rejects oversized body (>5 MiB)", async () => {
		const { validatePublishRequest, PublisherAuthError } = await import("../src/auth/publisher");
		const largeBody = "x".repeat(6 * 1024 * 1024); // 6 MiB
		const req = await buildSignedRequest(largeBody, "key1", TEST_SECRET_1);

		await expect(
			validatePublishRequest(req, PUBLISHER_SECRETS, db),
		).rejects.toThrow(PublisherAuthError);
	});

	it("extractPublisherHeaders returns structured data", async () => {
		const { extractPublisherHeaders } = await import("../src/auth/publisher");
		const req = await buildSignedRequest("{}", "key1", TEST_SECRET_1);
		const headers = extractPublisherHeaders(req);
		expect(headers.keyId).toBe("key1");
		expect(headers.nonce).toBeTruthy();
		expect(headers.timestamp).toBeGreaterThan(0);
		expect(headers.signature).toBeTruthy();
	});
});
