import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: "2025-09-06",
          d1Databases: ["CANVAS_DB"],
          r2Buckets: ["CANVAS_ARTIFACTS"],
        },
      },
    },
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.dom.test.ts"],
  },
});
