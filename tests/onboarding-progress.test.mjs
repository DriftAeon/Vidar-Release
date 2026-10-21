// onboarding/progress.ts: entry table rows, step navigation, and the onboarding.progress pref guard.
import test from "node:test";
import assert from "node:assert/strict";
import { entryFor, nextStep, prevStep, skippable, STEP_ORDER } from "../src/onboarding/progress.ts";
import { GUARDS } from "../src/prefs-core.ts";

const base = {
  progress: undefined,
  dependenciesSeen: false,
  primarySaved: false,
  choices: ["claude", "codex"],
  effective: "claude",
  requiredMissing: false,
};
const e = (o) => entryFor({ ...base, ...o });

test("row 1: finished stays out of the way, deps follows requiredMissing, no write", () => {
  const p = { step: "theme", finished: true };
  assert.deepEqual(e({ progress: p }), { kind: "none", deps: false, writePick: null });
  assert.deepEqual(e({ progress: p, requiredMissing: true, primarySaved: false }), { kind: "none", deps: true, writePick: null });
});

test("row order: finished beats dependenciesSeen; progress beats dependenciesSeen", () => {
  assert.equal(e({ progress: { step: "theme", finished: true }, dependenciesSeen: true }).writePick, null);
  assert.deepEqual(e({ progress: { step: "theme", finished: false }, dependenciesSeen: true }), { kind: "run", step: "theme", resumed: true });
});

test("row 2: unfinished resumes at its step; empty choices fall back to deps", () => {
  assert.deepEqual(e({ progress: { step: "modules", finished: false } }), { kind: "run", step: "modules", resumed: true });
  assert.deepEqual(e({ progress: { step: "modules", finished: false }, choices: [] }), { kind: "run", step: "deps", resumed: true });
  assert.deepEqual(e({ progress: { step: "deps", finished: false }, choices: [] }), { kind: "run", step: "deps", resumed: true });
});

test("row 3: dependenciesSeen writes the effective pick unless one is saved", () => {
  assert.deepEqual(e({ dependenciesSeen: true }), { kind: "none", deps: false, writePick: "claude" });
  assert.deepEqual(e({ dependenciesSeen: true, primarySaved: true }), { kind: "none", deps: false, writePick: null });
  assert.deepEqual(e({ dependenciesSeen: true, effective: null }), { kind: "none", deps: false, writePick: null });
  assert.equal(e({ dependenciesSeen: true, requiredMissing: true }).deps, true);
});

test("row 4: fresh install starts at deps when choices are empty or required is missing, else primary", () => {
  assert.deepEqual(e({}), { kind: "run", step: "primary", resumed: false });
  assert.deepEqual(e({ choices: [] }), { kind: "run", step: "deps", resumed: false });
  assert.deepEqual(e({ requiredMissing: true }), { kind: "run", step: "deps", resumed: false });
});

test("nextStep walks the order and skips runes when none are listed", () => {
  const on = { runesListed: true };
  const off = { runesListed: false };
  assert.equal(nextStep("deps", on), "primary");
  assert.equal(nextStep("modules", on), "runes");
  assert.equal(nextStep("modules", off), null);
  assert.equal(nextStep("runes", on), null);
});

test("prevStep walks back, never to deps unless shown, skips runes when unlisted", () => {
  const o = (runesListed, depsShown) => ({ runesListed, depsShown });
  assert.equal(prevStep("runes", o(true, true)), "modules");
  assert.equal(prevStep("primary", o(true, true)), "deps");
  assert.equal(prevStep("primary", o(true, false)), null);
  assert.equal(prevStep("deps", o(true, true)), null);
  assert.equal(prevStep("workspace", o(false, false)), "primary");
  assert.equal(prevStep("runes", o(false, true)), "modules");
});

test("skippable is workspace and runes only", () => {
  assert.deepEqual(STEP_ORDER.filter(skippable), ["workspace", "runes"]);
});

test("onboarding.progress guard accepts only the record shape", () => {
  const g = GUARDS["onboarding.progress"];
  assert.equal(g({ step: "deps", finished: false }), true);
  assert.equal(g({ step: "runes", finished: true, workspace: "C:\\x" }), true);
  assert.equal(g({ step: "nope", finished: false }), false);
  assert.equal(g({ step: "deps" }), false);
  assert.equal(g({ step: "deps", finished: "no" }), false);
  assert.equal(g({ step: "deps", finished: false, workspace: 3 }), false);
  assert.equal(g(null), false);
  assert.equal(g([]), false);
  assert.equal(g("deps"), false);
});
