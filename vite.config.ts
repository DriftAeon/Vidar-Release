import { resolve } from "node:path";
import { defineConfig } from "vite";

// Character renderer addons (src/character/addons/<id>, gitignored) are reached only through
// `@character-addons`. The release build sets VIDAR_CHARACTER_ADDONS=off so none of them is
// bundled into the shipped exe; tsconfig.json maps the specifier to addons-index.ts for tsc,
// and both index files are type-checked as part of src.
const characterAddons = process.env.VIDAR_CHARACTER_ADDONS === "off" ? "addons-none.ts" : "addons-index.ts";

// The style bench (tools/ui/bench.ps1) serves the repo root, so Vite's dependency scan would
// otherwise crawl every *.html under it (cargo target dirs, bridge bundles, mock drafts: ~1,700
// files, ~14 s before the first module is served). bench.ps1 sets VIDAR_BENCH=1; only then the
// scan is limited to the bench pages and their entry modules are transformed at startup.
const benchDir = `${import.meta.dirname.replace(/\\/g, "/")}/tools/ui/bench`;
const bench = process.env.VIDAR_BENCH === "1"
  ? {
      optimizeDeps: { entries: [`${benchDir}/*.html`] },
      warmup: { clientFiles: [`${benchDir}/*.ts`, `${benchDir}/sheets/*.ts`] },
      // Rooted at the repo, the watcher would walk every top-level folder (~90k files outside
      // the ignores below, ~19 s of main-thread time before the first request is served). The
      // bench imports only from src and tools, so any other top-level folder is ignored.
      watchIgnored: [(p: string) => {
        const rel = p.replace(/\\/g, "/").replace(`${import.meta.dirname.replace(/\\/g, "/")}/`, "");
        const top = rel.split("/")[0];
        return rel !== p.replace(/\\/g, "/") && !top.includes(".") && !/^(src|tools|node_modules)$/.test(top);
      }],
    }
  : { optimizeDeps: undefined, warmup: undefined, watchIgnored: [] as ((p: string) => boolean)[] };

export default defineConfig({
  optimizeDeps: bench.optimizeDeps,
  // The entry pages live in src/pages. They keep their `/src/...` references, which the `/src`
  // alias maps back to the repo src (root-relative URLs would otherwise resolve inside src/pages).
  // publicDir and build.outDir stay at the repo level so dist/ keeps the pages at its top.
  root: resolve(import.meta.dirname, "src/pages"),
  publicDir: resolve(import.meta.dirname, "public"),
  clearScreen: false,
  resolve: {
    alias: {
      "@character-addons": resolve(import.meta.dirname, "src/character", characterAddons),
      "/src": resolve(import.meta.dirname, "src"),
    },
  },
  // strictPort: if 1420 is taken, fail loudly instead of silently incrementing
  // while tauri.conf.json's devUrl still points at 1420.
  server: {
    port: 1420, strictPort: true,
    warmup: bench.warmup,
    // Never watch the Rust side: cargo's target\ is churn, and the watcher
    // walking it mid-link hits the locked vidar.exe (EBUSY) and kills `tauri dev`.
    // vendor\, bridge\, runtime\ and state\ are runtime data, never source — a model file
    // growing in vendor\ kept the watcher re-reading directories at ~1 core.
    watch: { ignored: ["**/src-tauri/**", "**/vendor/**", "**/bridge/**", "**/runtime/**",
      // Anchored: a bare **/state/** would also hide any future src\...\state\ folder.
      `${import.meta.dirname.replace(/\\/g, "/")}/state/**`, ...bench.watchIgnored] },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    // Vite's 500 kB default is calibrated for a website, where every kilobyte is transfer time.
    // Vidar loads its chunks off local disk through Tauri's custom protocol: nothing is
    // transferred, and the two big chunks are vendor libraries at their honest size (xterm.js in
    // `sessions`, three.js + GLTF loader in `renderer`). Raised rather than disabled so a chunk
    // that genuinely runs away still trips it; the per-chunk sizes stay in the build output.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      // second page: the transparent marquee overlay window (ocr.rs)
      input: {
        main: resolve(import.meta.dirname, "src/pages/index.html"),
        overlay: resolve(import.meta.dirname, "src/pages/overlay.html"),
        falcon: resolve(import.meta.dirname, "src/pages/falcon.html"),
      },
    },
  },
});
