import { defineConfig } from "vite";

// Vite config tuned for Tauri:
// - fixed port 1420 (matches `tauri.conf.json` -> build.devUrl)
// - strictPort so a port clash fails loudly instead of silently shifting
// - don't watch the Rust side (cargo/tauri handles that)
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  // Produce a build Tauri can embed; Tauri sets this env in CI/release.
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    // Mermaid is dynamically imported and code-split into large per-diagram
    // chunks that only load on demand — they never touch the initial bundle,
    // so the default 500 kB warning is noise here.
    chunkSizeWarningLimit: 700,
  },
});
