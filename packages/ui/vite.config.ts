import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    strictPort: false,
  },
  build: {
    // The Tauri shell will load this bundle verbatim later - keep it relative
    // so it works from a file:// origin as well as from `qa ui`.
    outDir: "dist",
    emptyOutDir: true,
  },
  base: "./",
});
