// Build the Falcon session host from source and stage it as a bundle Vidar in this checkout can start.
// Usage: npm run build:falcon [-- <extra cargo args>] [--no-prune]   (runs npm run build, then this script)
//        node tools/falcon/build.mjs [<extra cargo args, e.g. --offline>] [--no-prune]   (dist/ already built)
// --no-prune skips step 5 and is not passed to cargo.
// Steps:
//   1. copy dist/falcon.html, dist/assets and dist/icons into a fresh dist-falcon/ (src-falcon/tauri.conf.json
//      frontendDist; one folder so /assets/... URLs resolve as built)
//   2. touch src-falcon/src/main.rs (tauri-build has no rerun-if-changed for frontendDist, so a rebuild would
//      otherwise embed the previous frontend)
//   3. cargo build --release --locked --features tauri/custom-protocol --manifest-path src-falcon/Cargo.toml
//      (custom-protocol embeds the frontend; without it the exe loads a dev server)
//   4. stage a bundle under this checkout's falconBundles (contracts/paths.json) and point falconPointer
//      (current.json) at it, which is what Vidar's pick_bundle reads (src-tauri/src/falcon/host_launch.rs).
//   5. once current.json names the bundle, run pwsh -NoProfile -File tools/release/falcon-prune.ps1 -Root <this
//      checkout> (the release path's prune: keeps current, previous, registry, in-use and newer bundles). A prune
//      failure or a missing pwsh only warns on stderr; the exit code is unchanged. A tree without the script skips
//      the step silently.
// The bundle: falcon.exe, tauri.conf.json, sidecar/ (tools/claude-sidecar*.mjs plus the Agent SDK's
// package.json and sdk.mjs from this checkout's node_modules) and runtime-manifest.json (schema 4,
// runtimes claude + codex). It pins no CLI: the store stays empty, so Falcon runs the installed claude.exe
// and the installed Codex (src-falcon/src/claude.rs and codex.rs fall back to them), and node must be on PATH.
// The id is src-<16 hex> of the staged files' hashes; an existing bundle with that id is reused only when
// its files still hash to its manifest, never overwritten.
// Writes only dist-falcon/, the main.rs timestamp, cargo's target folder and, under this checkout's falcon
// folder, build/ (a scratch stage), bundles/<id>/ and current.json. Never starts, stops or contacts a host.
// Refuses: dist/ lacking falcon.html, assets/ or icons/ (run npm run build); node_modules without
// @anthropic-ai/claude-agent-sdk (run npm ci); repointing current.json while the registry names a live
// falcon.exe for this checkout (the bundle is still staged and nothing is pruned; quit Vidar, let the host
// exit, rerun).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve as contractPath } from "../lib/paths.mjs";

const SCHEME = "falcon-source-bundle/1";
const SDK = ["node_modules", "@anthropic-ai", "claude-agent-sdk"];
// No CLI is pinned: an all-zero hash names a store entry that never exists, so claude.rs goes to the installed CLI.
const NO_PINNED_CLI = "0".repeat(64);
// The sidecar scripts' folder under a checkout root: this file's grandparent, taken relative to the repo.
const TOOLS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOLS_REL = relative(dirname(TOOLS_DIR), TOOLS_DIR);

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sha256Text = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function filesUnder(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split("\\").join("/"));
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${randomUUID().replaceAll("-", "")}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Frontend digest as falcon-inputs.ps1 Get-FalconFrontendDigest: "<path>|<sha256>" lines, "\n"-joined, no trailing newline. */
export function frontendDigest(dir) {
  const top = new Set(["falcon.html", "assets", "icons"]);
  const lines = filesUnder(dir).filter((p) => top.has(p.split("/")[0])).map((p) => `${p}|${sha256File(join(dir, p))}`);
  return sha256Text(lines.join("\n"));
}

/** The installed-CLI lookup Falcon uses (content/packs/claude/pack.json probe; *.exe names only), as falcon-inputs.ps1 does. */
export function claudeInstalled(root) {
  let names = [], candidates = [];
  try {
    const pack = JSON.parse(readFileSync(join(root, "content", "packs", "claude", "pack.json"), "utf8").replace(/^\uFEFF/, ""));
    const probe = (pack.module?.deps ?? []).find((d) => d?.id === "claude")?.probe;
    const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(String);
    names = list(probe?.names).filter((n) => n.toLowerCase().endsWith(".exe") && !/[\\/]/.test(n) && n !== ".exe" && !n.includes(".."));
    candidates = list(probe?.candidates);
  } catch { /* no pack: the defaults below */ }
  if (names.length === 0) names = ["claude.exe"];
  if (candidates.length === 0) candidates = ["%USERPROFILE%\\.local\\bin\\claude.exe"];
  return { names, candidates };
}

/** pid and image check on the registry's host (what host_alive checks, minus the creation stamp): no pipe is opened. */
export function liveHost(registryPath, imageOf = tasklistImage) {
  if (!existsSync(registryPath)) return null;
  let pid;
  try { pid = JSON.parse(readFileSync(registryPath, "utf8").replace(/^\uFEFF/, "")).pid; } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const image = imageOf(pid);
  if (image === undefined) return { pid, image: "unknown" };   // could not tell: treat as running
  return image && image.toLowerCase() === "falcon.exe" ? { pid, image } : null;
}

function tasklistImage(pid) {
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  if (r.error || r.status !== 0) return undefined;
  const m = /^"([^"]+)","(\d+)"/m.exec(r.stdout);
  return m && Number(m[2]) === pid ? m[1] : null;
}

/**
 * Stage `exe` as a bundle under `root`'s falcon folder and point current.json at it.
 * Returns { bundleId, bundleDir, manifest, pointerPath, reused, repointed, refusal }.
 */
export function stageBundle({ root, exe, distFalcon = join(root, "dist-falcon"), imageOf } = {}) {
  const sdkDir = join(root, ...SDK);
  for (const f of ["package.json", "sdk.mjs"]) {
    if (!existsSync(join(sdkDir, f))) throw new Error(`${join(...SDK, f)} is missing. Run npm ci (or npm ci --offline) first.`);
  }
  const tools = join(root, TOOLS_REL);
  const sidecar = readdirSync(tools).filter((n) => /^claude-sidecar.*\.mjs$/.test(n) && !n.endsWith(".test.mjs")).sort();
  if (!sidecar.includes("claude-sidecar.mjs")) throw new Error(`${join(tools, "claude-sidecar.mjs")} is missing.`);
  const config = join(root, "src-falcon", "tauri.conf.json");
  const identifier = JSON.parse(readFileSync(config, "utf8")).identifier;

  // Bundle-relative path -> source file.
  const sources = new Map([["falcon.exe", exe], ["tauri.conf.json", config]]);
  for (const n of sidecar) sources.set(`sidecar/${n}`, join(tools, n));
  for (const f of ["package.json", "sdk.mjs"]) sources.set(`sidecar/${SDK.join("/")}/${f}`, join(sdkDir, f));
  const files = [...sources.keys()].sort().map((path) => ({ path, sha256: sha256File(sources.get(path)) }));
  const bundleId = `src-${sha256Text(`${SCHEME}\n${files.map((f) => `${f.path}|${f.sha256}`).join("\n")}\n`).slice(0, 16)}`;

  const bundles = contractPath("falconBundles", { root });
  const bundleDir = join(bundles, bundleId);
  const manifestPath = join(bundleDir, "runtime-manifest.json");
  let manifest, reused = false;
  if (existsSync(bundleDir)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch (e) {
      throw new Error(`${bundleDir} exists without a readable runtime-manifest.json (${e.message}); it was not reused or touched.`);
    }
    for (const f of manifest.files ?? []) {
      const p = join(bundleDir, ...f.path.split("/"));
      if (!existsSync(p) || sha256File(p) !== f.sha256) throw new Error(`${bundleDir}: ${f.path} no longer matches its manifest; it was not reused or touched.`);
    }
    if (manifest.bundle_id !== bundleId) throw new Error(`${bundleDir} claims bundle_id ${manifest.bundle_id}; it was not reused or touched.`);
    reused = true;
  } else {
    manifest = {
      schema_version: 4,
      schema: 4,
      runtimes: ["claude", "codex"],
      bundle_id: bundleId,
      built_by: "npm run build:falcon",
      ...(existsSync(join(distFalcon, "falcon.html")) ? { frontend_digest: frontendDigest(distFalcon) } : {}),
      created_utc: new Date().toISOString(),
      application: { product_name: "Falcon", identifier, profile_identity: `LOCALAPPDATA/${identifier}/<bundle-id>`, executable: "falcon.exe", config_snapshot: "tauri.conf.json" },
      frontend: { mode: "embedded", entrypoint: "falcon.html" },
      inputs: { scheme: SCHEME },
      files,
      claude: {
        sidecar: "sidecar/claude-sidecar.mjs",
        sdk: `sidecar/${SDK.join("/")}/sdk.mjs`,
        exe_sha256: NO_PINNED_CLI,
        store_exe: "claude.exe",
        installed: claudeInstalled(root),
      },
    };
    // Stage in the falcon build folder, then rename into bundles/: a half-copied folder never sits where pick_bundle scans.
    const scratch = join(contractPath("falconBuild", { root }), `source-stage-${randomUUID().replaceAll("-", "")}`);
    for (const [rel, src] of sources) {
      const dest = join(scratch, ...rel.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
    }
    writeFileSync(join(scratch, "runtime-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    mkdirSync(bundles, { recursive: true });
    renameSync(scratch, bundleDir);
  }

  const pointerPath = contractPath("falconPointer", { root });
  let previous = null;
  try { previous = JSON.parse(readFileSync(pointerPath, "utf8").replace(/^\uFEFF/, "")).bundle_id ?? null; } catch { /* none yet */ }
  if (previous === bundleId) return { bundleId, bundleDir, manifest, pointerPath, reused, repointed: false, refusal: null };
  const host = liveHost(contractPath("falconRegistry", { root }), imageOf);
  if (host) {
    const refusal = `a Falcon host for this checkout is running (pid ${host.pid}, ${host.image}); current.json still names ${previous ?? "nothing"}. Quit Vidar, let the host exit, then rerun.`;
    return { bundleId, bundleDir, manifest, pointerPath, reused, repointed: false, refusal };
  }
  writeJsonAtomic(pointerPath, { bundle_id: bundleId, executable: join(bundleDir, "falcon.exe"), ...(previous ? { previous_bundle_id: previous } : {}) });
  return { bundleId, bundleDir, manifest, pointerPath, reused, repointed: true, refusal: null };
}

/** Run tools/release/falcon-prune.ps1 against `root`. Returns { ok, detail }; never throws (a missing pwsh is a failed run). */
export function runPrune(root, script = join(TOOLS_DIR, "release", "falcon-prune.ps1")) {
  if (!existsSync(script)) return { ok: true, skipped: true, detail: "" };
  const r = spawnSync("pwsh", ["-NoProfile", "-File", script, "-Root", root], { stdio: "inherit", windowsHide: true });
  if (r.error) return { ok: false, detail: `could not run pwsh: ${r.error.message}` };
  return r.status === 0 ? { ok: true, detail: "" } : { ok: false, detail: `falcon-prune.ps1 exited ${r.status}` };
}

/**
 * What follows a staged bundle: a refusal exits 2 and prunes nothing; otherwise old bundles are pruned unless
 * `noPrune`. A prune failure only warns. Returns the exit code.
 */
export function settleStage({ root, result, noPrune = false, prune = runPrune, warn = (m) => console.error(m) }) {
  if (result.refusal) return 2;
  if (noPrune) return 0;
  let outcome;
  try { outcome = prune(root); } catch (e) { outcome = { ok: false, detail: e.message }; }
  if (outcome.skipped) return 0;
  if (!outcome.ok) warn(`build:falcon: warning: old bundles were not pruned (${outcome.detail}); run tools/release/falcon-prune.ps1 -Root ${root}`);
  return 0;
}

function onPath(name) {
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

function main() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const noPrune = process.argv.includes("--no-prune");
  const cargoArgs = process.argv.slice(2).filter((a) => a !== "--no-prune");
  const dist = join(repo, "dist");
  const staged = join(repo, "dist-falcon");

  for (const part of ["falcon.html", "assets", "icons"]) {
    if (!existsSync(join(dist, part))) {
      console.error(`build:falcon: ${join("dist", part)} is missing. Run npm run build first.`);
      process.exit(1);
    }
  }
  if (!existsSync(join(repo, ...SDK, "sdk.mjs"))) {
    console.error(`build:falcon: ${join(...SDK)} is missing. Run npm ci (or npm ci --offline) first.`);
    process.exit(1);
  }
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged);
  for (const part of ["falcon.html", "assets", "icons"]) cpSync(join(dist, part), join(staged, part), { recursive: true });

  const now = new Date();
  utimesSync(join(repo, "src-falcon", "src", "main.rs"), now, now);

  const args = ["build", "--release", "--locked", "--features", "tauri/custom-protocol",
    "--manifest-path", join(repo, "src-falcon", "Cargo.toml"), ...cargoArgs];
  console.log(`build:falcon: cargo ${args.join(" ")}`);
  const r = spawnSync("cargo", args, { cwd: repo, stdio: "inherit" });
  if (r.error) { console.error(`build:falcon: could not run cargo: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) process.exit(r.status ?? 1);
  const target = process.env.CARGO_TARGET_DIR ? resolve(repo, process.env.CARGO_TARGET_DIR) : join(repo, "src-falcon", "target");
  const exe = join(target, "release", process.platform === "win32" ? "falcon.exe" : "falcon");
  console.log(`build:falcon: built ${exe}`);

  let result;
  try { result = stageBundle({ root: repo, exe }); } catch (e) { console.error(`build:falcon: ${e.message}`); process.exit(1); }
  console.log(`build:falcon: ${result.reused ? "reused" : "staged"} bundle ${result.bundleId} at ${result.bundleDir}`);
  for (const f of result.manifest.files) console.log(`  ${f.path}`);
  console.log("  runtime-manifest.json");
  if (result.refusal) { console.error(`build:falcon: not repointed: ${result.refusal}`); process.exit(settleStage({ root: repo, result, noPrune })); }
  console.log(`build:falcon: ${result.pointerPath} ${result.repointed ? "now names" : "already names"} ${result.bundleId}`);
  settleStage({ root: repo, result, noPrune });
  const installed = result.manifest.claude.installed;
  const claude = installed.names.map(onPath).find(Boolean)
    ?? installed.candidates.map((c) => c.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? "\0")).find((p) => !p.includes("\0") && existsSync(p));
  console.log(`build:falcon: at run time Falcon needs node on PATH (${onPath("node.exe") ?? "not found"}), the Claude CLI (${claude ?? "not found"}) and, for Codex, the npm-global @openai/codex.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
