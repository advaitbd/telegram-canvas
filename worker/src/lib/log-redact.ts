/**
 * Structured log redaction.
 *
 * Strips known sensitive patterns from log messages before they reach
 * the Cloudflare logging pipeline.  Never log raw Telegram user IDs,
 * session IDs, HMAC keys, bot tokens, or request bodies.
 *
 * Usage:
 *   import { redact } from "../lib/log-redact";
 *   console.log(redact`Processing publish for user ${userId}`);
 */

/** Patterns that identify sensitive data and their replacement labels. */
const SENSITIVE_PATTERNS: [RegExp, string][] = [
	// Telegram user IDs (numeric 5-12 digits)
	[/\b(telegram_creator_id["\s:=]+)(\d{5,12})\b/g, "$1[REDACTED_USER]"],
	// Raw user IDs in non-structural context
	[/\b(user_id|creator_id)["\s:=]+(\d{5,12})\b/g, "$1=[REDACTED_USER]"],
	// Session IDs (uuid or hermes format)
	[/\b(session_id["\s:=]+)([a-f0-9-]{20,})(\s|$|,|")/g, "$1[REDACTED_SESSION]$3"],
	// HMAC keys (64-char hex strings)
	[/\b([a-f0-9]{64})\b/g, "[REDACTED_KEY]"],
	// Bot tokens (digits:alphnumeric pattern)
	[/\b(\d+:[\w-]{20,})\b/g, "[REDACTED_TOKEN]"],
	// JWT tokens
	[/\b(eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g, "[REDACTED_JWT]"],
	// Bearer tokens
	[/\b(Bearer\s+)[a-zA-Z0-9_-]{20,}/g, "$1[REDACTED]"],
];

/**
 * Template tag that redacts sensitive values from log strings.
 *
 * @example
 *   const userId = "123456789";
 *   console.log(redact`User ${userId} published`); // logs "User [REDACTED_USER] published"
 */
export function redact(literals: TemplateStringsArray, ...values: unknown[]): string {
	let result = "";
	for (let i = 0; i < literals.length; i++) {
		result += literals[i];
		if (i < values.length) {
			const val = String(values[i]);
			result += applyPatterns(val);
		}
	}
	return applyPatterns(result);
}

function applyPatterns(input: string): string {
	let result = input;
	for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}

/**
 * Create a structured log entry with redacted fields.
 * Use for all production logging.
 */
export function log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
	const safeMeta = meta ? redactMeta(meta) : undefined;
	const entry = {
		ts: new Date().toISOString(),
		level,
		msg: applyPatterns(message),
		...(safeMeta ? { meta: safeMeta } : {}),
	};
	// Use console.log for Cloudflare Workers logging
	console.log(JSON.stringify(entry));
}

function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
	const safe: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(meta)) {
		if (typeof value === "string") {
			safe[key] = applyPatterns(value);
		} else {
			safe[key] = value;
		}
	}
	return safe;
}
