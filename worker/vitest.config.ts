import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // D1 test stub — no real database needed
          d1Databases: ["CANVAS_DB"],
        },
      },
    },
    include: ["test/**/*.test.ts"],
  },
});
