import test from "node:test";
import assert from "node:assert/strict";
import { compareRow, formatRow, formatReport, pageExpression } from "./row-heights.mjs";

const c = (cls, top, height) => ({ cls, top, height });

test("equal heights and centres pass", () => {
  assert.deepEqual(compareRow([c("a", 10, 24), c("b", 10, 24), c("c", 10.5, 24.5)], false), []);
});

test("height difference over 1px flags", () => {
  const bad = compareRow([c("jx-search", 10, 28), c("jx-pick", 10, 24)], false);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].length, 2);
});

test("same height but shifted centre flags", () => {
  assert.equal(compareRow([c("a", 10, 24), c("b", 12.5, 24)], false).length, 1);
});

test("exactly 1px passes", () => {
  assert.deepEqual(compareRow([c("a", 10, 24), c("b", 10, 25)], false), []);
});

test("a single control never flags", () => {
  assert.deepEqual(compareRow([c("a", 0, 10)], false), []);
});

test("wrapping rows compare per line", () => {
  const ctrls = [c("a", 0, 24), c("b", 0, 24), c("c", 40, 30), c("d", 40, 30)];
  assert.deepEqual(compareRow(ctrls, true), []);
  assert.equal(compareRow(ctrls, false).length, 1);
  assert.equal(compareRow([...ctrls.slice(0, 2), c("c", 40, 30), c("d", 40, 24)], true).length, 1);
});

test("formatting", () => {
  const f = { row: "#p > .row", controls: [{ cls: "input.s", height: 28, source: "x" }, { cls: "button.b", height: 24, source: "" }] };
  assert.equal(formatRow(f), "#p > .row  input.s 28px [x] | button.b 24px");
  assert.equal(formatReport({ surface: "S", scanned: 3, flagged: [] }), "surface: S\n0 rows flagged of 3 scanned");
});

test("page expression is self-contained and parses", () => {
  assert.doesNotThrow(() => new Function(`return ${pageExpression(".jira-pane")}`));
});
