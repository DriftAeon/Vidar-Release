// onboarding/steps.ts: the step registry and the footer state the shell renders (Back, Skip,
// Next or Finish, dots). Pure: node loads steps.ts and progress.ts directly.
import test from "node:test";
import assert from "node:assert/strict";
import { footerState, registerStep, stepView } from "../src/onboarding/steps.ts";

const all = () => true;
const only = (...ids) => (s) => ids.includes(s);
const f = (step, o = {}) => footerState(step, { runesListed: true, depsShown: false, registered: all, ...o });

test("registry: registerStep stores a view, stepView finds it, unknown ids are undefined", () => {
  const view = { id: "theme", title: "Theme", mount: () => () => {} };
  assert.equal(stepView("theme"), undefined);
  registerStep(view);
  assert.equal(stepView("theme"), view);
  assert.equal(stepView("modules"), undefined);
});

test("Back is hidden on the first shown step", () => {
  assert.equal(f("primary").back, null);
  assert.equal(f("primary", { depsShown: true }).back, "deps");
  assert.equal(f("deps", { depsShown: true }).back, null);
  assert.equal(f("workspace").back, "primary");
});

test("Skip shows only on Workspace and Runes", () => {
  const skips = ["deps", "primary", "workspace", "theme", "modules", "runes"].filter((s) => f(s, { depsShown: true }).skip);
  assert.deepEqual(skips, ["workspace", "runes"]);
});

test("Next reads Finish from the last shown step, Next elsewhere", () => {
  assert.deepEqual([f("runes").next, f("runes").nextLabel], [null, "Finish"]);
  assert.deepEqual([f("modules").next, f("modules").nextLabel], ["runes", "Next"]);
  // Runes not listed: Modules is the last step
  assert.deepEqual([f("modules", { runesListed: false }).next, f("modules", { runesListed: false }).nextLabel], [null, "Finish"]);
});

test("dots cover the shown steps; the Dependencies dot only when shown", () => {
  assert.deepEqual(f("primary").dots, ["primary", "workspace", "theme", "modules", "runes"]);
  assert.deepEqual(f("primary", { depsShown: true }).dots, ["deps", "primary", "workspace", "theme", "modules", "runes"]);
  assert.deepEqual(f("primary", { runesListed: false }).dots, ["primary", "workspace", "theme", "modules"]);
  assert.equal(f("theme").current, 2);
  assert.equal(f("deps", { depsShown: true }).current, 0);
});

test("steps without a registered view are skipped both ways and get no dot", () => {
  const reg = only("deps", "primary");
  const dep = f("deps", { depsShown: true, registered: reg });
  assert.deepEqual([dep.back, dep.next, dep.nextLabel], [null, "primary", "Next"]);
  const pri = f("primary", { depsShown: true, registered: reg });
  assert.deepEqual([pri.back, pri.next, pri.nextLabel], ["deps", null, "Finish"]);
  assert.deepEqual(pri.dots, ["deps", "primary"]);
  // a gap in the middle: Next jumps over it
  const gap = f("primary", { registered: only("primary", "theme") });
  assert.deepEqual([gap.next, gap.dots], ["theme", ["primary", "theme"]]);
});

test("the current step keeps its dot even when it is not registered", () => {
  const s = f("workspace", { registered: only("primary") });
  assert.deepEqual(s.dots, ["primary", "workspace"]);
  assert.equal(s.current, 1);
});
