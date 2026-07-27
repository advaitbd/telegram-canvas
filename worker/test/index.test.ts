/**
 * Placeholder test — validates the worker module loads.
 *
 * In future tasks this file is replaced with real integration tests
 * for D1, R2, DO, and route authorization.
 */

import { describe, it, expect } from "vitest";

describe("telegram-canvas worker", () => {
	it("should have a placeholder skeleton that compiles", async () => {
		// Dynamic import verifies the module has no syntax/import errors
		// under the Miniflare worker pool.
		const mod = await import("../src/index");
		expect(mod.default).toBeDefined();
		expect(mod.default.fetch).toBeInstanceOf(Function);
		expect(mod.default.scheduled).toBeInstanceOf(Function);
	});

	it("should return 200 for /api/health", async () => {
		const mod = await import("../src/index");

		// Minimal env stub for the skeleton worker; real bindings added in later tasks
		const env: Record<string, unknown> = {
			ASSETS: {
				fetch: () => new Response("asset", { status: 200 }),
			},
		};

		const req = new Request("http://localhost/api/health");
		const res = await mod.default.fetch(
			req,
			env as any,
			{} as ExecutionContext,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("ok", true);
	});
});
