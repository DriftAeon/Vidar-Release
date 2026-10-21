// Verify-pin check (Bare version pin): after a Claude update, shows whether a real Bare session still behaves as the
// profile's `verifiedVersion` says, so a pin bump takes minutes. Read-only unless --write.
//
// Usage: node tools/bare/verify-pin.mjs [--home <dir>] [--manifest <file>] [--transcript <file>] [--profile <file>]
//                                      [--write]
//   --home        a Bare home (the folder holding manifests and claude-config); default the newest folder under
//                 %LOCALAPPDATA%\Vidar\homes that has a manifests folder.
//   --manifest    a launch manifest; default the newest Claude one in <home>\manifests that records a
//                 binary.version (a Raw Bare launch; hosted ones record none and are skipped).
//   --transcript  a session transcript (.jsonl); default the newest under the manifest's claude-config\projects
//                 modified after the manifest's createdUtc whose lines carry a cwd.
//   --profile     the profile whose overlay names are allowed and whose verifiedVersion --write edits;
//                 default profiles\bare\claude.json in this repo.
//   --write       when every check passes, rewrite only the `verifiedVersion` line of the profile to the manifest's
//                 binary version. Nothing else is written, ever.
//
// Checks (PASS / FAIL / UNKNOWN, each with evidence):
//   1 env     every manifest env name is allowed (contracts/agent-env.json `allow`, the profile overlays, Vidar's own
//             VIDAR_* / FALCON_SESSION / HOMEDRIVE / HOMEPATH / `=X:` drive entries) and none is in `drop`.
//   2 version the transcript's `version` equals the manifest's binary version (UNKNOWN when the manifest has none,
//             as a Falcon-hosted launch records none).
//   3 loads   a CLAUDE.md or AGENTS.md sits in the session cwd and the transcript holds 0 `instructions` /
//             `nested_memory` attachments (UNKNOWN without that canary file).
//   4 mode    every `permissionMode` in the transcript is `auto`.
//   5 temp    the check turn's tool result (stdout of GetTempPath) is a path under the Bare home.
// No check turn in the transcript: prints the prompt to paste into a Bare tab, exits 2.
// On all PASS prints the commit subject and body for the bump.
//
// Refuses: no home, manifest or transcript found (exit 2); --write unless all five checks pass (exit 1).
// Exit codes: 0 all PASS; 1 any FAIL; 2 nothing to check (missing input or no check turn); 3 UNKNOWN without FAIL.
// Never launches Claude, Codex or Vidar. `node tools/bare/probe-pin.mjs` (run by /swap on a stale pin) makes the Raw
// Bare launch itself, with no manual tab, then runs this with --write.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = pathResolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PROMPT = 'Run pwsh -NoProfile -Command "[IO.Path]::GetTempPath()" and reply with only its output.';

function parseArgs(argv) {
  const o = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") o.write = true;
    else if (["--home", "--manifest", "--transcript", "--profile"].includes(a) && i + 1 < argv.length) o[a.slice(2)] = argv[++i];
    else die(2, `Unknown or incomplete argument ${a}`);
  }
  return o;
}

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));

function defaultHome() {
  const root = join(process.env.LOCALAPPDATA ?? "", "Vidar", "homes");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .map((n) => join(root, n))
    .filter((d) => existsSync(join(d, "manifests")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

function newestClaudeManifest(home) {
  const dir = join(home, "manifests");
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(".init.json")).sort().reverse();
  for (const n of names) {
    try {
      const m = readJson(join(dir, n));
      if (m.agent === "claude" && m.binary?.version) return join(dir, n);
    } catch { /* skip unreadable */ }
  }
  return null;
}

function listJsonl(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const p of readdirSync(dir)) {
    const sub = join(dir, p);
    if (!statSync(sub).isDirectory()) continue;
    for (const f of readdirSync(sub)) if (f.endsWith(".jsonl")) out.push(join(sub, f));
  }
  return out;
}

function readLines(file) {
  const out = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial line */ }
  }
  return out;
}

function pickTranscript(configDir, createdMs) {
  const files = listJsonl(join(configDir, "projects"))
    .map((f) => ({ f, t: statSync(f).mtimeMs }))
    .filter((x) => x.t >= createdMs)
    .sort((a, b) => b.t - a.t);
  for (const { f } of files) if (readLines(f).some((l) => typeof l.cwd === "string")) return f;
  return null;
}

const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");

function checkEnv(manifest, contract, profile) {
  const lc = (s) => s.toLowerCase();
  const overlay = new Set([...Object.keys(profile.overlay ?? {}), ...Object.keys(profile.rendered?.overlay ?? {})].map(lc));
  const allow = new Set(contract.allow.map(lc));
  const drops = contract.drop.map(globRe);
  const own = (n) => /^VIDAR_/i.test(n) || /^(FALCON_SESSION|HOMEDRIVE|HOMEPATH)$/i.test(n) || n.startsWith("=");
  const dropped = [], unlisted = [];
  for (const n of manifest.envNames ?? []) {
    if (overlay.has(lc(n))) continue;
    if (drops.some((r) => r.test(n))) dropped.push(n);
    else if (!allow.has(lc(n)) && !own(n)) unlisted.push(n);
  }
  if (!Array.isArray(manifest.envNames)) return ["UNKNOWN", "manifest has no envNames"];
  if (dropped.length || unlisted.length) {
    return ["FAIL", `${dropped.length ? "dropped names present: " + dropped.join(",") : ""}${dropped.length && unlisted.length ? "; " : ""}${unlisted.length ? "not allowed: " + unlisted.join(",") : ""}`];
  }
  return ["PASS", `${manifest.envNames.length} names, all allowed, none dropped`];
}

function checkVersion(manifest, lines) {
  const seen = [...new Set(lines.map((l) => l.version).filter((v) => typeof v === "string"))];
  const want = manifest.binary?.version;
  if (!seen.length) return ["UNKNOWN", "transcript carries no version"];
  if (!want) return ["UNKNOWN", `manifest binary.version is empty; transcript ${seen.join(",")}`];
  return seen.length === 1 && seen[0] === want ? ["PASS", `transcript ${seen[0]} = manifest ${want}`] : ["FAIL", `transcript ${seen.join(",")} vs manifest ${want}`];
}

function checkLoads(lines) {
  const cwd = lines.find((l) => typeof l.cwd === "string")?.cwd;
  const canary = cwd && ["CLAUDE.md", "AGENTS.md"].find((n) => existsSync(join(cwd, n)));
  if (!canary) return ["UNKNOWN", `no CLAUDE.md or AGENTS.md in ${cwd ?? "(no cwd)"}, so 0 loads proves nothing`];
  const loads = lines.filter((l) => l.type === "attachment" && ["instructions", "nested_memory"].includes(l.attachment?.type)).length;
  return loads === 0 ? ["PASS", `${canary} present in cwd, 0 instruction loads`] : ["FAIL", `${loads} instruction load attachments with ${canary} present`];
}

function checkMode(lines) {
  const modes = [...new Set(lines.map((l) => l.permissionMode).filter((m) => typeof m === "string"))];
  if (!modes.length) return ["UNKNOWN", "no permissionMode in transcript"];
  return modes.every((m) => m === "auto") ? ["PASS", "permissionMode auto"] : ["FAIL", `permissionMode ${modes.join(",")}`];
}

function checkTurn(lines) {
  for (const l of lines) {
    const out = l.toolUseResult?.stdout;
    if (typeof out === "string" && /^[A-Za-z]:\\[^\r\n]*$/.test(out.trim())) return out.trim();
  }
  return null;
}

function under(path, home) {
  const norm = (p) => pathResolve(p).toLowerCase();
  return (norm(path) + sep).startsWith(norm(home) + sep);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const profilePath = o.profile ? pathResolve(o.profile) : join(REPO, "profiles", "bare", "claude.json");
  const home = o.home ? pathResolve(o.home) : defaultHome();
  const manifestPath = o.manifest ? pathResolve(o.manifest) : home && newestClaudeManifest(home);
  if (!manifestPath || !existsSync(manifestPath)) die(2, "No Raw Bare Claude manifest (one recording binary.version) found: a Raw Bare tab is needed (hosted launches record no version). Use --home or --manifest.");
  const manifest = readJson(manifestPath);
  const bareHome = manifest.homes?.home || home || dirname(dirname(manifestPath));
  const configDir = manifest.homes?.claudeConfig || join(bareHome, "claude-config");
  const created = Date.parse(manifest.createdUtc ?? "") || 0;
  const transcript = o.transcript ? pathResolve(o.transcript) : pickTranscript(configDir, created);
  if (!transcript || !existsSync(transcript)) die(2, `No transcript newer than the manifest under ${join(configDir, "projects")}.`);
  const lines = readLines(transcript);
  const profile = readJson(profilePath);
  const contract = readJson(join(REPO, "contracts", "agent-env.json"));

  const turn = checkTurn(lines);
  const rows = [
    ["1 env", ...checkEnv(manifest, contract, profile)],
    ["2 version", ...checkVersion(manifest, lines)],
    ["3 loads", ...checkLoads(lines)],
    ["4 mode", ...checkMode(lines)],
    ["5 temp", ...(turn ? (under(turn, bareHome) ? ["PASS", `${turn} is under ${bareHome}`] : ["FAIL", `${turn} is outside ${bareHome}`]) : ["UNKNOWN", "no check turn"])],
  ];
  console.log(`manifest   ${manifestPath}\ntranscript ${transcript}`);
  for (const [name, verdict, ev] of rows) console.log(`${verdict.padEnd(8)} ${name.padEnd(10)} ${ev}`);

  if (!turn) {
    console.log(`\nNo check turn in the transcript. Paste into a Bare tab, then rerun:\n${PROMPT}`);
    process.exit(2);
  }
  const v = manifest.binary?.version;
  if (rows.some((r) => r[1] === "FAIL")) process.exit(1);
  if (rows.some((r) => r[1] === "UNKNOWN")) {
    if (o.write) die(1, "--write needs all five checks to pass.");
    process.exit(3);
  }
  console.log(`\n[Chore] Bare - Verify Claude ${v}\n\nChecked a Bare session on ${v}: env scrub, version, no instruction loads, auto mode and Bare temp path all held.\nPins profiles/bare/claude.json verifiedVersion to ${v}.`);
  if (o.write) {
    const text = readFileSync(profilePath, "utf8");
    const next = text.replace(/^(\s*"verifiedVersion"\s*:\s*)"[^"\r\n]*"/m, `$1"${v}"`);
    if (next === text && !text.includes(`"${v}"`)) die(1, "No verifiedVersion line found in the profile.");
    if (next !== text) writeFileSync(profilePath, next);
    console.log(`Wrote verifiedVersion ${v} to ${profilePath}`);
  }
  process.exit(0);
}

// Importing this file (probe-pin.mjs takes PROMPT) must not run the checks.
if (process.argv[1] && pathResolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
