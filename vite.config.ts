import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";

const tauriTarget = process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [wasm(), topLevelAwait(), react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  resolve: {
    alias: {
      assert: "assert",
    },
  },
  esbuild: {
    target: tauriTarget,
  },
  build: {
    outDir: "dist/frontend",
    target: tauriTarget,
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
