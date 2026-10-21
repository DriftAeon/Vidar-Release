// Chain-bar R3 bracket (rendered-chain.css): an open group's tool pill sits on the bracket line and
// takes its first row's class colour (--group-tc, read through :has). The group map must name every
// tool class the row map (--chain-tc) names, or a group of that class would fall back to grey.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const css = readFileSync(join(root, "src", "styles", "rendered-chain.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

/** "tool class -> colour token" for every rule setting `prop`, one entry per class and state selector */
function classMap(prop, scope) {
  const out = new Map();
  for (const r of rules) {
    const v = r.body.match(new RegExp(`${prop}:\\s*var\\((--[\\w-]+)\\)`));
    if (!v) continue;
    for (const sel of r.sel.split(/,(?![^(]*\))/)) {
      if (!sel.includes(scope)) continue;
      const classes = [...sel.matchAll(/data-tool-class="(\w+)"/g)].map((m) => m[1]);
      const state = (sel.match(/:is\((\.[^)]*)\)\s*\)?$/) ?? [, ""])[1].replace(/\s/g, "");
      for (const c of classes) out.set(`${c}${state ? ` ${state}` : ""}`, v[1]);
    }
  }
  return out;
}

test("group bracket colour map covers the row class map, colour for colour", () => {
  const rows = classMap("--chain-tc", ".blk-tool");
  const groups = classMap("--group-tc", ".blk-activity");
  assert.ok(rows.size >= 8, `row map parsed (${rows.size})`);
  assert.deepEqual([...groups].sort(), [...rows].sort());
});

test("open group: flush left, bracket grey for the pill's top edge then --group-tc, pill on the line", () => {
  const sum = rules.find((r) => r.sel === ".rendered .blk-activity[open]:not(.empty) > summary");
  assert.ok(sum, "open summary rule");
  assert.doesNotMatch(sum.body, /margin-left/);
  assert.match(sum.body, /border-image:\s*linear-gradient\(to bottom,\s*transparent calc\(50% - var\(--row-24\) \/ 2 - var\(--border-w\)\),\s*var\(--border-strong\) 0 calc\(50% - var\(--row-24\) \/ 2\),\s*var\(--group-tc\) 0\)/);
  const pill = rules.find((r) => r.sel === ".rendered .blk-activity[open]:not(.empty) > summary > .activity-label.chain-bar");
  assert.ok(pill, "open pill rule");
  assert.match(pill.body, /margin-left:\s*calc\(-1 \* var\(--space-2\)\)/);
  assert.match(pill.body, /border-left:\s*var\(--space-2\) solid transparent/);
  assert.match(pill.body, /background-clip:\s*padding-box/);
  // the rows' gutter is the header's edge column, so opening shifts nothing
  const row = rules.find((r) => r.sel === ".rendered :is(.blk-activity, .tool-children) > .blk-tool");
  assert.match(row.body, /margin:\s*0;/);
});

test("collapsed group: flush left, bracket clear, pill keeps its grey edge", () => {
  const sum = rules.find((r) => r.sel === ".rendered .blk-activity > summary");
  assert.doesNotMatch(sum.body, /margin-left/);
  assert.match(sum.body, /padding:\s*0 var\(--space-8\) 0 0/);
  assert.match(sum.body, /border-left:\s*var\(--space-2\) solid transparent/);
  const base = rules.find((r) => r.sel === ".rendered .activity-label.chain-bar");
  assert.match(base.body, /border:\s*var\(--border-w\) solid var\(--border-strong\)/);
  // no state rule recolours the bracket: the first-row colour covers running and error groups
  assert.ok(!rules.some((r) => /blk-activity\[data-state/.test(r.sel)), "no data-state bracket rule in rendered-chain.css");
});
