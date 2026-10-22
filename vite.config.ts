import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  build: { outDir: "../web-dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:4300" } },
});
