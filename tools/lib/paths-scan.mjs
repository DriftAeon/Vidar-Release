// Scan for hard-coded layout paths that should go through the paths contract.
// Whole-literal matches only: a quoted string whose entire content, after separator
// normalisation (any run of backslashes -> "/"), stripping leading "./" and "../" and a trailing
// "/", equals a contract id's rel path. A literal built from
// pieces ('bridge' joined with 'review') is counted only through its whole-literal parts.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ids, rel, root } from "./paths.mjs";

const EXT = /\.(mjs|js|ts|ps1|rs)$/;
const EXCLUDE = [/^tools\/lib\//, /^src\/paths\.ts$/, /^contracts\//, /^tests\//, /^docs\//,
  /^src-tauri\/src\/paths(\.rs|\/)/, /^src-tauri\/src\/falcon\/layout\.rs$/,
  // Claude Code mods run inside Claude Code's process and cannot import this contract; their
  // bridge paths are reviewed by hand.
  /^plugins\//];
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
// Module specifiers (`from "x"`, `import("x")`, `import "x"`) are not runtime path literals.
// The lookbehind keeps `PathBuf::from("x")` / `X.from("x")` counted.
const SPECIFIER = /(?<![.:\w])(?:from|import)\s*\(?\s*$/;

// Textual TS type positions only. Keep this bounded: a value after `=` (including a typed
// variable's initializer) and an object literal property are still runtime literals.
function typePosition(text, at) {
  const prefix = text.slice(Math.max(0, at - 512), at);
  const statement = prefix.slice(Math.max(prefix.lastIndexOf(";"), prefix.lastIndexOf("}")) + 1);
  if (/(?:^|\n)\s*(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=\s*[^;]*$/.test(statement)) return true;
  if (/(?:^|\n)\s*(?:export\s+)?(?:interface\s+\w+[^{]*|type\s+\w+(?:<[^>]*>)?\s*=)\s*\{[^}]*$/.test(prefix)) return true;
  const line = prefix.slice(prefix.lastIndexOf("\n") + 1);
  return /\b(?:const|let|var)\s+[\w$]+\s*:\s*(?:(?:["'`][^"'`\n]*["'`]\s*\|\s*)*)$/.test(line);
}

function normalise(s) {
  return s.replace(/\\+/g, "/").replace(/^(?:\.{1,2}\/)+/, "").replace(/\/$/, "");
}

// path -> id. Contract order wins on a collision.
function buildIndex() {
  const index = new Map();
  for (const id of Object.keys(ids())) {
    const p = rel(id);
    if (p && !index.has(p)) index.set(p, id);
  }
  return index;
}

export function scanText(text, index = buildIndex(), counts = new Map()) {
  for (const m of text.matchAll(LITERAL)) {
    if (SPECIFIER.test(text.slice(Math.max(0, m.index - 16), m.index))) continue;
    if (typePosition(text, m.index)) continue;
    const id = index.get(normalise(m[2]));
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

// No .git (a source export or a zip download): walk the tree, skipping build output and local state
// that .gitignore would hide.
const WALK_SKIP = new Set([".git", "node_modules", "target", "dist", "dist-falcon", "runtime", "__pycache__", ".venv"]);
function walkFiles(base, dir = "", out = []) {
  for (const e of readdirSync(join(base, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!WALK_SKIP.has(e.name) && !e.name.startsWith(".")) walkFiles(base, rel, out); }
    else out.push(rel);
  }
  return out;
}

function trackedFiles(base = root()) {
  // Untracked files too: an executor's gate runs before anything is staged, and a literal it
  // cannot see then fails the pre-commit gate (twice on 2026-10-11).
  const out = existsSync(join(base, ".git"))
    ? execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: base, encoding: "utf8", maxBuffer: 64 << 20 })
    : walkFiles(base).join("\n");
  return out.split("\n").map((f) => f.trim()).filter((f) => f && EXT.test(f) && !EXCLUDE.some((r) => r.test(f)));
}

// Counts per id across all tracked and untracked, not-ignored files: Map<id, number>.
export function scanRepo(base = root()) {
  const index = buildIndex();
  const counts = new Map();
  for (const f of trackedFiles(base)) {
    let text;
    try { text = readFileSync(join(base, f), "utf8"); } catch { continue; }
    scanText(text, index, counts);
  }
  return counts;
}
