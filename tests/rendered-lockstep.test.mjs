// Rendered lockstep: the Rendered body must look and behave the same in the Vidar tab and the
// Falcon shell. So its new styles live only in src/styles/rendered-*.css and name no host or
// theme, and host branching (hostHas / opts.host) stays in the three files that own it.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const rel = (p) => relative(root, p).split(sep).join("/");

const FORBIDDEN_SELECTORS = [".rendered-host", ".term-container", "#falcon", "[data-theme"];
const HOST_BRANCH_ALLOWED = new Set([
  "src/panels/rendered/events.ts",
  "src/panels/rendered.ts",
  "src/panels/rendered/host-profile.ts",
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("rendered-*.css: no rule selects on host or theme", () => {
  const dir = join(root, "src", "styles");
  const files = readdirSync(dir).filter((f) => /^rendered-.*\.css$/.test(f));
  assert.ok(files.length >= 5, "expected the rendered-*.css files");
  const bad = [];
  for (const f of files) {
    const css = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{/g)) {
      const selector = m[1];
      for (const token of FORBIDDEN_SELECTORS) {
        if (selector.includes(token)) bad.push(`${f}: ${token} in "${selector.trim().slice(0, 80)}"`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("rendered sources: hostHas( and opts.host only in events.ts, rendered.ts, host-profile.ts", () => {
  const files = [
    ...walk(join(root, "src", "panels", "rendered")).filter((p) => p.endsWith(".ts")),
    join(root, "src", "panels", "rendered.ts"),
  ];
  const bad = [];
  for (const p of files) {
    const r = rel(p);
    if (HOST_BRANCH_ALLOWED.has(r)) continue;
    const src = readFileSync(p, "utf8");
    for (const token of ["hostHas(", "opts.host"]) {
      if (src.includes(token)) bad.push(`${r}: ${token}`);
    }
  }
  assert.deepEqual(bad, []);
});
