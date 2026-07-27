/**
 * Authorization helper tests:
 *   - CSRF token generation and verification
 *   - Shell session cookie creation and parsing
 *   - Identity hash derivation
 *   - HTTP response helpers
 */

import { describe, it, expect } from "vitest";

describe("CSRF tokens", () => {
	it("generates a 64-char hex token", async () => {
		const { generateCsrfToken } = await import("../src/lib/http");
		const token = generateCsrfToken();
		expect(token.length).toBe(64);
		expect(/^[0-9a-f]+$/.test(token)).toBe(true);
	});

	it("generates unique tokens", async () => {
		const { generateCsrfToken } = await import("../src/lib/http");
		const t1 = generateCsrfToken();
		const t2 = generateCsrfToken();
		expect(t1).not.toBe(t2);
	});
});

describe("Shell session cookie", () => {
	it("creates a properly formatted __Host- cookie", async () => {
		const { createSessionCookie } = await import("../src/lib/http");
		const future = new Date(Date.now() + 3600000);
		const cookie = createSessionCookie("sess_test_value", future);

		expect(cookie).toContain("__Host-canvas_session=sess_test_value");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Expires=");
		// __Host- prefix forbids Domain attribute
		expect(cookie).not.toContain("Domain=");
	});

	it("parses the cookie value from a request", async () => {
		const { createSessionCookie, parseSessionCookie } = await import("../src/lib/http");
		const future = new Date(Date.now() + 3600000);
		const cookieValue = "sess_abc123";
		const cookie = createSessionCookie(cookieValue, future);

		const req = new Request("https://canvas.advaitdeshpande.com/api/test", {
			headers: { Cookie: cookie },
		});
		expect(parseSessionCookie(req)).toBe(cookieValue);
	});

	it("returns null when no cookie is present", async () => {
		const { parseSessionCookie } = await import("../src/lib/http");
		const req = new Request("https://canvas.advaitdeshpande.com/api/test");
		expect(parseSessionCookie(req)).toBeNull();
	});
});

describe("Identity hash derivation", () => {
	const TEST_IDENTITY_KEY = "ab" + "cd".repeat(31); // 64 hex chars

	it("deriveOwnerHash produces a deterministic hex string", async () => {
		const { deriveOwnerHash } = await import("../src/auth/identity");
		const hash = await deriveOwnerHash("123456789", TEST_IDENTITY_KEY);
		expect(hash.length).toBe(64);
		expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
	});

	it("deriveSessionHash produces a deterministic hex string", async () => {
		const { deriveSessionHash } = await import("../src/auth/identity");
		const hash = await deriveSessionHash("session_abc", TEST_IDENTITY_KEY);
		expect(hash.length).toBe(64);
		expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
	});

	it("same input produces same hash (deterministic)", async () => {
		const { deriveOwnerHash } = await import("../src/auth/identity");
		const h1 = await deriveOwnerHash("user42", TEST_IDENTITY_KEY);
		const h2 = await deriveOwnerHash("user42", TEST_IDENTITY_KEY);
		expect(h1).toBe(h2);
	});

	it("different inputs produce different hashes", async () => {
		const { deriveOwnerHash } = await import("../src/auth/identity");
		const h1 = await deriveOwnerHash("user42", TEST_IDENTITY_KEY);
		const h2 = await deriveOwnerHash("user99", TEST_IDENTITY_KEY);
		expect(h1).not.toBe(h2);
	});

	it("owner and session hashes are domain-separated", async () => {
		const { deriveOwnerHash, deriveSessionHash } = await import("../src/auth/identity");
		// Even with the same input string, domain prefixes differ
		const owner = await deriveOwnerHash("same_input", TEST_IDENTITY_KEY);
		const session = await deriveSessionHash("same_input", TEST_IDENTITY_KEY);
		expect(owner).not.toBe(session);
	});
});

describe("JSON response helpers", () => {
	it("jsonError returns correct status and body", async () => {
		const { jsonError } = await import("../src/lib/http");
		const res = jsonError(401, "Unauthorized");
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body).toHaveProperty("error", "Unauthorized");
	});

	it("jsonOk returns 200 with data", async () => {
		const { jsonOk } = await import("../src/lib/http");
		const res = jsonOk({ ok: true, count: 42 });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("ok", true);
	});

	it("security headers are present on error responses", async () => {
		const { jsonError } = await import("../src/lib/http");
		const res = jsonError(403, "Forbidden");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});
});
