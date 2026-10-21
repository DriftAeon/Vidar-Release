// PreToolUse guard, vendor tabs only (wired into the fence tools\vendor\vendor-tab.ps1 builds;
// never the global ~\.claude\settings.json). Closes the write-hole flagged in
// docs\shelf\vendor-model-slots-and-fable-leak.md: the vendor fence denies `Edit(...)` and
// `PowerShell(Set-Content*|Out-File*|Add-Content*)` on protected paths, but has nothing on `Bash`,
// so a vendor tab with the Bash tool could reach a denied path via shell redirect (`>`, `>>`),
// `cp`/`mv`/`tee`, or `sed -i` — none of those are caught by prefix-matched permission rules.
//
// Protected (mirrors the deny list's path set):
//   - everything under the user's ~/.claude EXCEPT ~/.claude/vendor/** (the vendor tabs' own lane)
//   - this repo's .claude/ directory and its CLAUDE.md file
//   - the .claude/ of the cwd and of its git top level (project settings, loaded by the tab)
//   - this repo's tools/vendor/ and bridge/vendor/ (the fence's sources and resolved files, A3)
//
// Write scope is deliberately narrow: only Bash, only a write TARGET under a protected path. Reads,
// writes elsewhere (including anywhere under ~/.claude/vendor/**), and all other tools pass
// through untouched. Bash and PowerShell commands are also checked for user-environment reads.
//
// Parsing is pragmatic, not a shell parser: per-segment (split on && || ; | and newlines) regexes
// for `>`/`>>` redirects, `cp`/`mv` (last non-flag token = destination), `tee` (all non-flag
// tokens = destinations), and `sed -i`/`--in-place` (last token in the segment = file). False
// negatives (a write this misses) are acceptable; false positives on ordinary or vendor-lane work
// are not, so ambiguous shapes are left alone rather than guessed at.
//
// Contract: stdin JSON, exit 0 = allow, exit 2 + stderr = block (text goes back to the model).
// Same shape as ~\.claude\hooks\guard-crawl.mjs and guard-bash-write.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TRIP_LOG = join(homedir(), ".claude", "hooks", "trip-log.mjs");

let raw = "";
try { raw = readFileSync(0, "utf8").replace(/^﻿/, ""); } catch { process.exit(0); }
if (!raw.trim()) process.exit(0);
let d;
try { d = JSON.parse(raw); } catch { process.exit(0); }

const tool = String(d.tool_name ?? "");
if (tool !== "Bash" && tool !== "PowerShell") process.exit(0);
const cmd = String((d.tool_input ?? {}).command ?? "");
if (!cmd.trim()) process.exit(0);

// User-environment reads (where the vendor keys live). Permission deny rules match case-sensitively,
// so this check is the case-insensitive backstop. It targets the resource, not a tool name: the
// HKCU\Environment key (any prefix or separator, so `reg query` of it is covered), the Machine key
// under Session Manager, and GetEnvironmentVariable(s) with a User/Machine target.
const USER_ENV_READ = [
  /\b(?:HKCU|HKEY_CURRENT_USER)\s*[:\\/]*\s*[\\/]\s*Environment\b/i,
  /\b(?:HKLM|HKEY_LOCAL_MACHINE)\b[^\n]*Session\s*Manager\s*[\\/]\s*Environment\b/i,
  /GetEnvironmentVariables?\s*\([^)]*(?:\b(?:User|Machine)\b|,\s*[12]\s*(?=\)))/i,
];
if (USER_ENV_READ.some((re) => re.test(cmd))) {
  process.stderr.write("vendor-write guard: BLOCKED - reads the user environment (HKCU\\Environment, GetEnvironmentVariable with a User/Machine target). Vendor tabs cannot read credentials from the registry.\n");
  if (process.env.VIDAR_FENCE_PROBE !== "1") {
    try { const { logTrip } = await import(pathToFileURL(TRIP_LOG).href); logTrip("guard-vendor-write", d, "user environment read"); } catch {}
  }
  process.exit(2);
}
// The write checks below cover shell redirects, which only Bash has.
if (tool !== "Bash") process.exit(0);

const HOME_FWD = homedir().replace(/\\/g, "/").replace(/\/+$/, "");
const REPO_ROOT_FWD = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
  .replace(/\\/g, "/").replace(/\/+$/, "");

// Bridge dir from the layout contract; the literal is the fallback when the contract reader cannot
// load (a guard must never fail open). The bridge dir is the parent of a bridge child id (falcon),
// so no bare bridge literal is needed.
let BRIDGE_VENDOR = ["runtime/bridge/vendor"];
try {
  const P = await import("../lib/paths.mjs");
  const parent = (x) => x.replace(/\\/g, "/").replace(/\/[^/]*$/, "").toLowerCase();
  BRIDGE_VENDOR = [`${parent(P.rel("falcon"))}/vendor`];
} catch {}

function tokenize(s) {
  return s.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
}
function strip(p) { return p.replace(/^["']|["']$/g, "").trim(); }

// Best-effort resolve a raw command-line token to a forward-slash path for comparison. Not a real
// filesystem resolve (no disk access) — text normalization only, matching how the tokens actually
// appear in a vendor tab's Bash calls.
function normalize(tok) {
  let p = strip(tok).replace(/\\/g, "/");
  if (/^~(?:\/|$)/.test(p)) p = p.replace(/^~/, HOME_FWD);
  else if (/^\$HOME(?:\/|$)/.test(p)) p = p.replace(/^\$HOME/, HOME_FWD);
  else if (/^\$env:USERPROFILE(?:\/|$)/i.test(p)) p = p.replace(/^\$env:USERPROFILE/i, HOME_FWD);
  else if (/^%USERPROFILE%(?:\/|$)/i.test(p)) p = p.replace(/^%USERPROFILE%/i, HOME_FWD);
  p = p.replace(/^\/([A-Za-z])(?=\/|$)/, (_, letter) => `${letter.toUpperCase()}:`);
  if (!/^[A-Za-z]:\//.test(p) && !p.startsWith("/")) {
    p = `${REPO_ROOT_FWD}/${p.replace(/^\.\//, "")}`;
  }
  return p;
}

// The project's .claude (loaded as settings): the cwd's and the git top level's, same set the fence
// denies for Edit. Resolved lazily; a failed git lookup leaves the cwd alone (git absent or not a repo).
let projectDirsCache = null;
function projectClaudeDirs() {
  if (projectDirsCache) return projectDirsCache;
  const dirs = [process.cwd()];
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top) dirs.push(top);
  } catch {}
  projectDirsCache = [...new Set(dirs.map((x) => `${resolve(x).replace(/\\/g, "/").replace(/\/+$/, "")}/.claude`.toLowerCase()))];
  return projectDirsCache;
}

function isProtected(tok) {
  const p = normalize(tok).toLowerCase();
  const home = HOME_FWD.toLowerCase();
  const repo = REPO_ROOT_FWD.toLowerCase();
  const homeClaude = `${home}/.claude`;
  if (p === homeClaude || p.startsWith(`${homeClaude}/`)) {
    const vendorLane = `${homeClaude}/vendor`;
    if (p === vendorLane || p.startsWith(`${vendorLane}/`)) return false;
    return true;
  }
  const repoClaude = `${repo}/.claude`;
  if (p === repoClaude || p.startsWith(`${repoClaude}/`)) return true;
  if (p.includes("/.claude") && projectClaudeDirs().some((c) => p === c || p.startsWith(`${c}/`))) return true;
  if (p === `${repo}/claude.md`) return true;
  // The fence's own sources and its resolved per-tab file: a tab must not loosen the
  // fence it runs under, nor the one the next launch builds.
  for (const sub of ["tools/vendor", ...BRIDGE_VENDOR]) {
    const d = `${repo}/${sub}`;
    if (p === d || p.startsWith(`${d}/`)) return true;
  }
  return false;
}

// Segment the command on chain/pipe operators so each verb is inspected against its own arguments.
const SEGMENTS = cmd.split(/&&|\|\||[|;\n]/);

let hit = null;

for (const seg of SEGMENTS) {
  if (hit) break;

  // 1. Output redirects: `>`/`>>` (optionally fd-prefixed), skipping fd dups (`2>&1`) and /dev/null|NUL.
  const redirectRe = /(?:^|[\s])(?:[12]?>{1,2}|&>{1,2})(?!&)\s*(?<p>"[^"]+"|'[^']+'|\S+)/g;
  let m;
  while ((m = redirectRe.exec(seg))) {
    const target = strip(m.groups.p);
    if (!target || /^(\/dev\/null|NUL)$/i.test(target)) continue;
    if (isProtected(target)) { hit = { reason: `redirects output into ${target}` }; break; }
  }
  if (hit) break;

  // 2. cp / mv: destination is the last non-flag token.
  const cpmv = seg.match(/\b(cp|mv)\b\s+(.*)$/);
  if (cpmv) {
    const args = tokenize(cpmv[2]).filter((t) => !t.startsWith("-"));
    const dest = args[args.length - 1];
    if (args.length >= 2 && dest && isProtected(dest)) {
      hit = { reason: `${cpmv[1]} writes into ${strip(dest)}` };
      break;
    }
  }

  // 3. tee: every non-flag token is a destination file.
  const teeM = seg.match(/\btee\b\s*(.*)$/);
  if (teeM) {
    const args = tokenize(teeM[1]).filter((t) => !t.startsWith("-"));
    const dest = args.find((t) => isProtected(t));
    if (dest) { hit = { reason: `tee writes into ${strip(dest)}` }; break; }
  }

  // 4. sed -i / --in-place: pragmatic — if the segment turns on in-place edit, treat its last
  // token as the file being edited (the common `sed -i 's/../..' path` / `sed -i.bak '...' path` shape).
  if (/\bsed\b/.test(seg) && /(^|\s)-[A-Za-z]*i(\.\S+)?(\s|$)|--in-place(=\S+)?(\s|$)/.test(seg)) {
    const args = tokenize(seg);
    const dest = args[args.length - 1];
    if (dest && isProtected(dest)) { hit = { reason: `sed -i edits ${strip(dest)}` }; break; }
  }
}

if (!hit) process.exit(0);

process.stderr.write(
  `vendor-write guard: BLOCKED - ${hit.reason}. Vendor tabs may only write under ` +
  `~/.claude/vendor/** (their own lane); everything else under ~/.claude, and this repo's ` +
  `.claude/ and CLAUDE.md, are read-only from here regardless of tool.\n`,
);
// vendor-tab.ps1's pre-launch probe is not a trip; it sets VIDAR_FENCE_PROBE for that one call.
if (process.env.VIDAR_FENCE_PROBE !== "1") {
  try { const { logTrip } = await import(pathToFileURL(TRIP_LOG).href); logTrip("guard-vendor-write", d, hit.reason); } catch {}
}
process.exit(2);
