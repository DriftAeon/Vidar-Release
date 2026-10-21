// Runtime import cycles in src/**/*.ts may not grow (contracts/import-cycles.json is the allowlist).
// Type-only imports are erased and excluded. The JSON changes by hand, never from this test.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const at = (p) => relative(ROOT, p).split("\\").join("/");

function listTs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listTs(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function resolveSpec(from, spec) {
  const base = resolve(dirname(from), spec);
  const tries = [base, `${base}.ts`, join(base, "index.ts"), base.replace(/\.js$/, ".ts")];
  return tries.find((c) => c.endsWith(".ts") && existsSync(c) && statSync(c).isFile());
}

const FROM = /^\s*(import|export)\s+(type\s+)?[^"'`]*?\bfrom\s*["'](\.[^"']*)["']/;
const SIDE = /^\s*import\s*["'](\.[^"']*)["']/;

function buildGraph() {
  const graph = new Map();
  for (const file of listTs(SRC)) {
    const deps = new Set();
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(FROM);
      if (m && m[2]) continue;
      const spec = m ? m[3] : line.match(SIDE)?.[1];
      if (!spec) continue;
      const target = resolveSpec(file, spec);
      if (target && target !== file) deps.add(at(target));
    }
    graph.set(at(file), [...deps]);
  }
  return graph;
}

function cycles(graph) {
  let n = 0;
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], out = [];
  const visit = (v) => {
    idx.set(v, n); low.set(v, n++); stack.push(v); on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const scc = [];
      let w;
      do { w = stack.pop(); on.delete(w); scc.push(w); } while (w !== v);
      if (scc.length >= 2) out.push(scc.sort());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

test("runtime import cycles in src stay within contracts/import-cycles.json", () => {
  const allowed = JSON.parse(readFileSync(join(ROOT, "contracts", "import-cycles.json"), "utf8")).cycles;
  const found = cycles(buildGraph());
  const bad = found.filter((c) => !allowed.some((a) => c.every((f) => a.includes(f))));
  assert.deepEqual(
    bad,
    [],
    `new or grown import cycle(s); break the edge, or freeze by hand. Found now:\n${JSON.stringify({ cycles: found }, null, 2)}`,
  );
  const shrunk = allowed.filter((a) => !found.some((c) => c.length === a.length && c.every((f) => a.includes(f))));
  if (shrunk.length) console.log(`import-cycles: allowlist entries that shrank or vanished (trim by hand):\n${JSON.stringify(found, null, 2)}`);
});
