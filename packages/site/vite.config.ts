import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5280, strictPort: false },
  build: { outDir: "dist", emptyOutDir: true, cssMinify: "lightningcss" },
  base: "./",
});
