import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          d1Databases: ["CANVAS_DB"],
          r2Buckets: ["CANVAS_ARTIFACTS"],
        },
      },
    },
    include: ["test/**/*.test.ts"],
  },
});
