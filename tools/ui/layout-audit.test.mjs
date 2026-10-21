import test from "node:test";
import assert from "node:assert/strict";
import { classSel, shortSelector, gapAxis, formatFinding, formatReport, pageExpression } from "./layout-audit.mjs";

const el = (tagName, { id = "", cls = [], parent = null, ids = null } = {}) => {
  const e = { tagName, id, classList: cls, parentElement: parent };
  e.closest = (s) => {
    for (let p = e; p; p = p.parentElement) if (p.id) return p;
    return null;
  };
  return e;
};

test("classSel drops state classes", () => {
  assert.equal(classSel(el("DIV", { cls: ["a", "active", "b", "hidden"] })), ".a.b");
  assert.equal(classSel(el("DIV", { cls: ["dead"] })), null);
});

test("shortSelector prefers id, adds one id of context for classes", () => {
  const body = el("BODY");
  const app = el("DIV", { id: "app", parent: body });
  const bar = el("DIV", { id: "left-bar", parent: app });
  const cc = el("DIV", { cls: ["character-controls"], parent: bar });
  assert.equal(shortSelector(bar), "#left-bar");
  assert.equal(shortSelector(cc), "#left-bar .character-controls");
  const underApp = el("DIV", { cls: ["x"], parent: app });
  assert.equal(shortSelector(underApp), ".x");
});

test("shortSelector climbs to a classed ancestor", () => {
  const body = el("BODY");
  const bar = el("DIV", { id: "bar", parent: body });
  const row = el("DIV", { cls: ["row"], parent: bar });
  const bare = el("SPAN", { parent: row });
  assert.equal(shortSelector(bare), "#bar .row");
});

test("gapAxis picks the gap along the main axis", () => {
  assert.deepEqual(gapAxis({ display: "flex", flexDirection: "column", rowGap: "6px", columnGap: "2px" }), { axis: "column", gap: 6 });
  assert.deepEqual(gapAxis({ display: "flex", flexDirection: "row", rowGap: "6px", columnGap: "2px" }), { axis: "row", gap: 2 });
  assert.deepEqual(gapAxis({ display: "flex", flexDirection: "row", rowGap: "normal", columnGap: "normal" }), { axis: "row", gap: 0 });
  assert.deepEqual(gapAxis({ display: "grid", flexDirection: "row", rowGap: "8px", columnGap: "4px" }), { axis: "column", gap: 8 });
});

test("formatting", () => {
  const f = { container: "#a", child: ".b", axis: "column", gap: 6, wasted: 6, count: 1 };
  assert.equal(formatFinding(f), "6px  #a > .b  (column gap 6)");
  assert.equal(formatReport([f, f]), "6px  #a > .b  (column gap 6)\n6px  #a > .b  (column gap 6)\n2 findings, 12 px");
  assert.equal(formatReport([]), "0 findings, 0 px");
});

test("page expression is self-contained and parses", () => {
  assert.doesNotThrow(() => new Function(`return ${pageExpression()}`));
});
