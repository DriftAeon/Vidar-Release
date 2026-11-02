// Node reader for contracts/paths.json (the layout contract). Twin: tools/lib/Paths.ps1.
// Semantics: rel(id) is the path under the root; resolve(id) is that rel joined onto the root.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentRows } from "./agent-table.mjs";

// The agent table loads through agent-table.mjs (guarded import: a release-shape copy of tools/ ships without
// src/, and most tools here only resolve contract paths, so absent, only `agentRoots` refuses).

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

// Every agent's root in table order (src/agents/descriptor.ts): its `homeEnv` var when non-empty, else
// `<home>/<userDir>`. Twin of paths.rs `agent_roots_in`.
export function agentRoots(env = process.env) {
  const home = env.USERPROFILE ?? env.HOME ?? "";
  return agentRows().map((a) => (env[a.homeEnv] ? env[a.homeEnv] : join(home, a.userDir)));
}

// The global rune library outside the repo; twin of paths.rs `global_runes_dir`: the first agent root that is a
// directory (even without `runes/`) gives `<root>/runes`, none gives the last agent's. Never creates a folder.
export function globalRunesDir(env = process.env, isDir = isDirOnDisk) {
  const roots = agentRoots(env);
  return join(roots.find((r) => isDir(r)) ?? roots[roots.length - 1], "runes");
}
