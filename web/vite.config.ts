import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// 开发时把 /api /files /skill-files 代理到 Bun 后端；生产由 server 直接托管 dist。
export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/files": "http://127.0.0.1:8787",
      "/skill-files": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
