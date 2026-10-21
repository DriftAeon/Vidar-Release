// The Settings Cards list (panels/rendered/card-kinds.ts) stays in step with tool-class.ts and the
// chain colour rules in rendered-chain.css.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { CARD_KINDS } = await import("../src/panels/rendered/card-kinds.ts");
const { TOOL_CLASS } = await import("../src/panels/rendered/tool-class.ts");

const root = join(fileURLToPath(import.meta.url), "..", "..");
const css = readFileSync(join(root, "src", "styles", "rendered-chain.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("every tool class appears in CARD_KINDS exactly once", () => {
  const classes = new Set(["other", ...Object.values(TOOL_CLASS).flatMap((t) => Object.values(t))]);
  const listed = CARD_KINDS.map((k) => k.cls);
  assert.equal(new Set(listed).size, listed.length, "no class listed twice");
  assert.deepEqual([...listed].sort(), [...classes].sort());
});

test("every claude and codex table tool is listed under its kind, and nothing else", () => {
  const table = new Map();
  for (const agent of Object.values(TOOL_CLASS)) {
    for (const [name, cls] of Object.entries(agent)) {
      assert.ok(!table.has(name) || table.get(name) === cls, `${name} keeps one class across agents`);
      table.set(name, cls);
    }
  }
  for (const k of CARD_KINDS) {
    const expected = [...table].filter(([, c]) => c === k.cls).map(([n]) => n).sort();
    assert.deepEqual([...k.tools].sort(), expected, `${k.cls} tools`);
    if (k.tools.length) assert.ok(k.tools.includes(k.sample), `${k.cls} sample is one of its tools`);
  }
});

test("every CARD_KINDS class has a data-tool-class colour rule in rendered-chain.css", () => {
  for (const k of CARD_KINDS) {
    assert.match(css, new RegExp(`\\.chain-seg\\)\\[data-tool-class="${k.cls}"\\]`), `${k.cls} rule`);
  }
});
