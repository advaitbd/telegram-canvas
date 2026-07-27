/**
 * Feature-flag kill switches for the Canvas Worker.
 *
 * Environment variables read at request time (not startup) so flags
 * can be toggled without a redeploy via `wrangler secret put`.
 *
 * Available flags:
 *   CANVAS_PUBLISH_DISABLED  — set to "1" to reject all publish requests
 *   CANVAS_STREAM_DISABLED   — set to "1" to reject WebSocket stream upgrades
 *   CANVAS_API_DISABLED      — set to "1" to reject all viewer API requests
 */

export interface FeatureFlags {
	publishDisabled: boolean;
	streamDisabled: boolean;
	apiDisabled: boolean;
}

/**
 * Read feature flags from environment/secret bindings.
 */
export function getFeatureFlags(env: Record<string, unknown>): FeatureFlags {
	return {
		publishDisabled: env.CANVAS_PUBLISH_DISABLED === "1",
		streamDisabled: env.CANVAS_STREAM_DISABLED === "1",
		apiDisabled: env.CANVAS_API_DISABLED === "1",
	};
}

/**
 * HTTP 503 response for disabled features.
 */
export function featureDisabledResponse(feature: string): Response {
	return new Response(
		JSON.stringify({ error: `${feature} is currently disabled` }),
		{
			status: 503,
			headers: { "content-type": "application/json" },
		},
	);
}
