import { describe, expect, it, vi } from "vitest";
import { CanvasApi } from "../public/api";

describe("Canvas API read errors", () => {
  it("preserves HTTP status for session-expiry handling", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })));

    await expect(new CanvasApi().listSessions()).rejects.toThrow("401");
  });
});
