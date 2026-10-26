import { test } from "node:test";
import assert from "node:assert/strict";
import { owedGaps, OWED_SINCE } from "./owed.mjs";

const NEW = `${OWED_SINCE}-demo`;
const run = (notes, extra = {}) => [{ name: NEW, notes, context: "", ...extra }];

test("closed with no heading is flagged", () => {
  const g = owedGaps(run("- run closed"));
  assert.deepEqual(g, [{ run: NEW, problem: 'no "Owed to the user" heading' }]);
});

test("closed with heading and - none is clean", () => {
  assert.deepEqual(owedGaps(run("run closed\n## Owed to the user\n- none\n")), []);
});

test("closed with park lines is clean", () => {
  assert.deepEqual(owedGaps(run("run closed\n## Owed to the user\n- parked a1: do x\n- unparked a1: done\n")), []);
});

test("unpark closers with a paren or at end of line count as park lines", () => {
  assert.deepEqual(owedGaps(run("run closed\n## Owed to the user\n- parked a1: x\n- unparked a1 (why): y\n- unparked a2\n")), []);
});

test("an opener without the colon is not a park line", () => {
  assert.equal(owedGaps(run("run closed\n## Owed to the user\n- parked a1 do x\n")).length, 1);
});

test("closed with a plain bullet is flagged", () => {
  const g = owedGaps(run("run closed\n## Owed to the user\n- ask about y\n"));
  assert.equal(g.length, 1);
  assert.equal(g[0].problem, "owed item not parked: - ask about y");
});

test("empty section is flagged", () => {
  const g = owedGaps(run("run closed\n## Owed to the user\n\n## Next\n- x\n"));
  assert.equal(g[0].problem, 'empty "Owed to the user" section (write - none)');
});

test("open run is not flagged", () => {
  assert.deepEqual(owedGaps(run("- working on it")), []);
});

test("pre-OWED_SINCE run is not flagged", () => {
  assert.deepEqual(owedGaps([{ name: "2026-10-07-old", notes: "run closed", context: "" }]), []);
});

test("CONTEXT Status: merged counts as closed", () => {
  assert.equal(owedGaps(run("", { context: "Status: merged\n" })).length, 1);
});

test("section ends at the next heading", () => {
  assert.deepEqual(owedGaps(run("run closed\n## Owed to the user\n- none\n## Other\n- loose bullet\n")), []);
});
