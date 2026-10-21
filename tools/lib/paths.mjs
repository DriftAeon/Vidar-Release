// Node reader for contracts/paths.json (the layout contract). Twin: tools/lib/Paths.ps1.
// Semantics: rel(id) is the path under the root; resolve(id) is that rel joined onto the root.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "contracts/paths.json";
const HERE = dirname(fileURLToPath(import.meta.url));
let contract = null;

export function root(start) {
  for (const from of [start, HERE].filter(Boolean)) {
    let dir = pathResolve(from);
    for (;;) {
      if (existsSync(join(dir, MARKER))) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  throw new Error(`paths: no directory containing ${MARKER} found above ${start ?? HERE}`);
}

export function ids() {
  if (!contract) {
    contract = JSON.parse(readFileSync(join(root(), "contracts", "paths.json"), "utf8"));
  }
  return contract.ids;
}

function node(id) {
  const n = ids()[id];
  if (!n) throw new Error(`paths: unknown id "${id}"`);
  return n;
}

export function rel(id) {
  const n = node(id);
  const base = n.under === "root" ? "" : rel(n.under);
  return [base, n.rel].filter(Boolean).join("/");
}

export function resolve(id, opts = {}) {
  const base = opts.root ? pathResolve(opts.root) : root();
  return join(base, rel(id));
}

const isDirOnDisk = (p) => existsSync(p) && statSync(p).isDirectory();

// The global rune library outside the repo; twin of paths.rs `global_runes_dir`: `~/.claude/runes` when
// `~/.claude` is a directory, else `<CODEX_HOME (non-empty) or ~/.codex>/runes`. Never creates either.
export function globalRunesDir(env = process.env, isDir = isDirOnDisk) {
  const home = env.USERPROFILE ?? env.HOME ?? "";
  const claude = join(home, ".claude");
  if (isDir(claude)) return join(claude, "runes");
  const codex = env.CODEX_HOME ? env.CODEX_HOME : join(home, ".codex");
  return join(codex, "runes");
}
