import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "public",
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, "public", "index.html"),
    },
  },
  server: {
    port: 5173,
  },
});
