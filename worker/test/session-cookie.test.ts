import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { getOwnerFromCookie, handleTelegramAuth } from "../src/routes/auth";
import { bytesToHex, deriveOwnerHash, importIdentityKey } from "../src/auth/identity";
import { ALICE_OWNER, BOB_OWNER, IDENTITY_KEY, makeSessionCookie } from "./helpers/session-cookie";

const request = (cookie?: string) => new Request("https://canvas.example/api/sessions", {
	headers: cookie ? { Cookie: cookie } : {},
});

// Independent raw signing also tests that signed but invalid fields are rejected.
async function signedPayload(payload: string, domain = "canvas-session-cookie:"): Promise<string> {
	const signature = await crypto.subtle.sign("HMAC", await importIdentityKey(IDENTITY_KEY), new TextEncoder().encode(domain + payload));
	return `__Host-canvas_session=${payload}.${bytesToHex(new Uint8Array(signature))}`;
}

afterEach(() => vi.restoreAllMocks());

describe("authenticated expiring session cookies", () => {
	it("accepts a signed owner among unrelated cookies, and rotates the nonce", async () => {
		const first = await makeSessionCookie(ALICE_OWNER);
		expect(await getOwnerFromCookie(request(`other=value; ${first}; another=value`), IDENTITY_KEY)).toBe(ALICE_OWNER);
		expect(await makeSessionCookie(ALICE_OWNER)).not.toBe(first);
	});

	it("rejects missing and legacy unsigned cookies", async () => {
		for (const cookie of [undefined, "__Host-canvas_session=", `__Host-canvas_session=${crypto.randomUUID()}.${ALICE_OWNER}`]) {
			expect(await getOwnerFromCookie(request(cookie), IDENTITY_KEY)).toBeNull();
		}
	});

	it.each(["version", "nonce", "owner", "expiry", "signature"])("rejects a tampered %s", async (field) => {
		const cookie = await makeSessionCookie(ALICE_OWNER);
		const parts = cookie.split("=")[1].split(".");
		const index = ["version", "nonce", "owner", "expiry", "signature"].indexOf(field);
		if (field === "owner") parts[index] = BOB_OWNER;
		else if (field === "expiry") parts[index] = String(Number(parts[index]) - 1);
		else if (field === "nonce") parts[index] = crypto.randomUUID();
		else parts[index] = (parts[index][0] === "0" ? "1" : "0") + parts[index].slice(1);
		expect(await getOwnerFromCookie(request(`__Host-canvas_session=${parts.join(".")}`), IDENTITY_KEY)).toBeNull();
	});

	it("enforces expiration on the server at the exact boundary without relying on browser Expires", async () => {
		const now = Math.floor(Date.now() / 1000);
		const cookie = await makeSessionCookie(ALICE_OWNER, now + 3600);
		const clock = vi.spyOn(Date, "now").mockReturnValue((now + 3599) * 1000);
		expect(await getOwnerFromCookie(request(cookie), IDENTITY_KEY)).toBe(ALICE_OWNER);
		clock.mockReturnValue((now + 3600) * 1000);
		expect(await getOwnerFromCookie(request(cookie), IDENTITY_KEY)).toBeNull();
		clock.mockReturnValue((now + 3601) * 1000);
		expect(await getOwnerFromCookie(request(cookie), IDENTITY_KEY)).toBeNull();
	});

	it("rejects signed expired or excessively future-dated cookies", async () => {
		const now = Math.floor(Date.now() / 1000);
		vi.spyOn(Date, "now").mockReturnValue(now * 1000);
		for (const expires of [now - 1, now, now + 3601]) {
			expect(await getOwnerFromCookie(request(await makeSessionCookie(ALICE_OWNER, expires)), IDENTITY_KEY)).toBeNull();
		}
	});

	it("rejects malformed fields even with a valid HMAC", async () => {
		const nonce = crypto.randomUUID();
		const expiry = Math.floor(Date.now() / 1000) + 3600;
		const valid = ["v1", nonce, ALICE_OWNER, String(expiry)];
		for (const [index, value] of [
			[0, "v2"], [1, "not-a-uuid"], [1, nonce.toUpperCase()],
			[2, "owner_alice"], [2, "a".repeat(63)], [2, ALICE_OWNER.toUpperCase()],
			[3, `0${expiry}`], [3, `${expiry}.5`], [3, "NaN"], [3, "Infinity"],
			[3, "-1"], [3, "9007199254740992"], [3, "1e10"],
		] as Array<[number, string]>) {
			const parts = [...valid];
			parts[index] = value;
			expect(await getOwnerFromCookie(request(await signedPayload(parts.join("."))), IDENTITY_KEY)).toBeNull();
		}
		const cookie = await makeSessionCookie(ALICE_OWNER);
		for (const malformed of [cookie + ".extra", cookie.slice(0, -1), cookie.slice(0, -1) + "z", cookie + "=", cookie.replace("v1.", "v1..")]) {
			expect(await getOwnerFromCookie(request(malformed), IDENTITY_KEY)).toBeNull();
		}
	});

	it("rejects the wrong key and signatures from other HMAC domains", async () => {
		const cookie = await makeSessionCookie(ALICE_OWNER);
		expect(await getOwnerFromCookie(request(cookie), "34".repeat(32))).toBeNull();
		const payload = cookie.split("=")[1].split(".").slice(0, -1).join(".");
		for (const domain of ["", "telegram-owner:", "hermes-session:"]) {
			expect(await getOwnerFromCookie(request(await signedPayload(payload, domain)), IDENTITY_KEY)).toBeNull();
		}
	});

	it("preserves the login response and cookie flags, and issues a verifiable one-hour session", async () => {
		const botToken = "synthetic-test-bot-token";
		const user = { id: 123456789, first_name: "Test" };
		const now = Math.floor(Date.now() / 1000);
		vi.spyOn(Date, "now").mockReturnValue(now * 1000);
		const params = new URLSearchParams({ auth_date: String(now), user: JSON.stringify(user) });
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const secret = await crypto.subtle.sign("HMAC", key, encoder.encode(botToken));
		const telegramKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const signature = await crypto.subtle.sign("HMAC", telegramKey, encoder.encode([...params].map(([k, v]) => `${k}=${v}`).sort().join("\n")));
		params.set("hash", bytesToHex(new Uint8Array(signature)));
		const loginRequest = () => new Request("https://canvas.example/api/auth/telegram", { method: "POST", body: new URLSearchParams({ init_data: params.toString() }) });
		const loginEnv = { CANVAS_DB: env.CANVAS_DB, TELEGRAM_BOT_TOKEN: botToken, IDENTITY_HMAC_KEY: IDENTITY_KEY };
		const response = await handleTelegramAuth(loginRequest(), loginEnv);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, user });
		const cookie = response.headers.get("set-cookie")!;
		for (const flag of ["Secure", "HttpOnly", "Path=/", "SameSite=Lax", `Expires=${new Date((now + 3600) * 1000).toUTCString()}`]) expect(cookie).toContain(`; ${flag}`);
		expect(cookie).not.toContain("Domain=");
		expect(cookie.split(";")[0].split(".")[3]).toBe(String(now + 3600));
		expect(await getOwnerFromCookie(request(cookie.split(";")[0]), IDENTITY_KEY)).toBe(await deriveOwnerHash(String(user.id), IDENTITY_KEY));
		expect((await handleTelegramAuth(loginRequest(), loginEnv)).headers.get("set-cookie")).not.toBe(cookie);
	});
});
