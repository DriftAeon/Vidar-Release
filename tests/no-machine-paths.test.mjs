// Shipped sources must not carry this machine's paths (C:\Main, Users\zero) in any escaping.
// Known, accepted hits live in no-machine-paths.allow.json as a per-file COUNT (not line
// numbers, so edits elsewhere in a file never churn it). Paths come from one of three roots:
// the Vidar folder, the user folder, the work folder.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Every tracked root the release zip ships (tools/release/ship-list.txt); tests and tools included,
// since the release scrub refuses on them too and a leak should fail here first, at commit.
const SCANNED = ["src", "src-tauri/src", "src-falcon/src", "content/local-voice", "content/packs", "public", "contracts", "tests", "tools", "runes"];
// Export-ignored (.gitattributes): never in the zip, so their paths are not a leak.
const SKIP_PATHS = new Set(["tools/release", "tools/measure"]);
const SKIP_DIRS = new Set(["node_modules", "__pycache__", "target", ".git"]);
const MAX_BYTES = 2 * 1024 * 1024;
// C:\Main, C:\\Main, C:\\\\Main, C:/Main; Users\zero, Users/zero (any backslash run).
const PATTERN = /C:(?:\\+|\/)Main|Users(?:\\+|\/)zero/gi;
const POINTER = 'see docs/reference/module-boundaries.md "three roots"';

// The index (git ls-files: staged new files included) under the scanned roots, instead of walking the tree:
// untracked local state (.venv, caches, target) is never listed, and the walk's directory reads are gone.
// A source export or zip download has no .git: walk the scanned roots instead, skipping the same dot dirs.
const HAS_GIT = existsSync(join(ROOT, ".git"));
function walk(rel, out) {
  let entries;
  try { entries = readdirSync(join(ROOT, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(`${rel}/${e.name}`, out); }
    else out.push(`${rel}/${e.name}`);
  }
  return out;
}
function listedFiles() {
  if (!HAS_GIT) return SCANNED.flatMap((root) => walk(root, []));
  const r = spawnSync("git", ["ls-files", "-z", "--", ...SCANNED], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `git ls-files: ${r.stderr}`);
  return r.stdout.split("\0");
}

function* trackedFiles() {
  for (const rel of listedFiles()) {
    if (!rel) continue;
    const parts = rel.split("/");
    if ([...SKIP_PATHS].some((p) => rel.startsWith(p + "/"))) continue;
    // Dot dirs are local runtime state (local-voice/.venv, .cache, .tmp), never shipped.
    if (parts.slice(0, -1).some((s) => SKIP_DIRS.has(s) || s.startsWith("."))) continue;
    const abs = join(ROOT, rel);
    if (existsSync(abs)) yield abs; // listed but deleted on disk: skip
  }
}

function countHits() {
  const hits = new Map();
  for (const file of trackedFiles()) {
    if (statSync(file).size > MAX_BYTES) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary (wav, onnx, pyc)
    const n = (buf.toString("utf8").match(PATTERN) ?? []).length;
    if (n > 0) hits.set(relative(ROOT, file).replaceAll("\\", "/"), n);
  }
  return hits;
}

function loadAllow() {
  const raw = JSON.parse(readFileSync(new URL("./no-machine-paths.allow.json", import.meta.url), "utf8"));
  const allow = new Map();
  for (const e of raw.entries) allow.set(e.path, e);
  return allow;
}

test("shipped sources carry no machine paths beyond the allowlist", () => {
  const hits = countHits();
  const allow = loadAllow();
  const problems = [];
  for (const [path, n] of hits) {
    const entry = allow.get(path);
    if (!entry) problems.push(`${path}: ${n} machine-path hit(s), not allowlisted; ${POINTER}`);
    else if (n > entry.count) problems.push(`${path}: ${n} machine-path hit(s), allowlist allows ${entry.count}; ${POINTER}`);
  }
  for (const [path, entry] of allow) {
    const n = hits.get(path) ?? 0;
    if (!HAS_GIT && !existsSync(join(ROOT, path))) continue; // export-ignored file: not in this tree, nothing to go stale
    if (n < entry.count) problems.push(`${path}: ${n} machine-path hit(s), allowlist says ${entry.count}; stale entry, lower the count in tests/no-machine-paths.allow.json${n === 0 ? " (or remove it)" : ""}`);
  }
  assert.deepEqual(problems, [], "\n" + problems.join("\n"));
});
