import { signSessionCookieValue } from "../../src/routes/auth";

// Synthetic test-only identity key and realistic owner HMAC shapes.
export const IDENTITY_KEY = "12".repeat(32);
export const ALICE_OWNER = "a".repeat(64);
export const BOB_OWNER = "b".repeat(64);

export async function makeSessionCookie(owner: string, expires = Math.floor(Date.now() / 1000) + 3600): Promise<string> {
	return `__Host-canvas_session=${await signSessionCookieValue(owner, IDENTITY_KEY, expires)}`;
}
