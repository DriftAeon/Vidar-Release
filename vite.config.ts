import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  // strictPort: if 1420 is taken, fail loudly instead of silently incrementing
  // while tauri.conf.json's devUrl still points at 1420.
  server: {
    port: 1420, strictPort: true,
    // Never watch the Rust side: cargo's target\ is churn, and the watcher
    // walking it mid-link hits the locked vidar.exe (EBUSY) and kills `tauri dev`.
    // vendor\, bridge\, runtime\ and state\ are runtime data, never source — a model file
    // growing in vendor\ kept the watcher re-reading directories at ~1 core.
    watch: { ignored: ["**/src-tauri/**", "**/vendor/**", "**/bridge/**", "**/runtime/**",
      // Anchored: a bare **/state/** would also hide any future src\...\state\ folder.
      `${import.meta.dirname.replace(/\\/g, "/")}/state/**`] },
  },
  build: {
    // Vite's 500 kB default is calibrated for a website, where every kilobyte is transfer time.
    // Vidar loads its chunks off local disk through Tauri's custom protocol: nothing is
    // transferred, and the two big chunks are vendor libraries at their honest size (xterm.js in
    // `sessions`, three.js + GLTF loader in `renderer`). Raised rather than disabled so a chunk
    // that genuinely runs away still trips it; the per-chunk sizes stay in the build output.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      // second page: the transparent marquee overlay window (ocr.rs)
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        overlay: resolve(import.meta.dirname, "overlay.html"),
        falcon: resolve(import.meta.dirname, "falcon.html"),
      },
    },
  },
});
