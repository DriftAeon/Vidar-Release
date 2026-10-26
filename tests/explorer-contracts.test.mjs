import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSnapshot, validateRunLogLine, validateFindingLine, validateGoalFile, FLAGS, FINDING_KINDS,
} from "../tools/drive/explorer-contracts.mjs";

const node = () => ({
  ref: "e1", role: "button", name: "Go", state: { enabled: true, focused: false },
  locator: { role: "button", name: "Go", nth: 0 }, flags: ["zero-size"], bbox: { x: 0, y: 0, w: 10, h: 10 },
});
const snap = () => ({ v: 1, port: 9222, timeOrigin: 1.5, full: true, reason: "start", nodes: [node()], removed: ["e2"] });

test("snapshot: valid", () => assert.deepEqual(validateSnapshot(snap()), []));
test("snapshot: bad ref, flag, reason, version", () => {
  const s = snap();
  s.v = 2; s.reason = "later"; s.nodes[0].ref = "x1"; s.nodes[0].flags = ["nope"];
  const e = validateSnapshot(s).join("\n");
  for (const m of ["v:", "reason", "ref", "unknown flag nope"]) assert.match(e, new RegExp(m));
});
test("snapshot: every enum flag is accepted", () => {
  const s = snap(); s.nodes[0].flags = [...FLAGS];
  assert.deepEqual(validateSnapshot(s), []);
});

test("runlog: valid", () => {
  const l = { t: "2026-10-24T10:00:00Z", port: 9222, episode: "ep1", verb: "click", args: ["#x"],
    target: { ref: "e3", locator: { role: "button", name: "Go", nth: 0 } }, hit: { ok: true, ref: "e3", tag: "BUTTON" }, exit: 0 };
  assert.deepEqual(validateRunLogLine(l), []);
});
test("runlog: missing verb, bad target ref", () => {
  const e = validateRunLogLine({ t: "x", port: 1, episode: 1, args: [], target: { ref: "3", locator: {} }, exit: 0 }).join("\n");
  assert.match(e, /verb/); assert.match(e, /target\.ref/);
});

test("runlog: selector target is valid, empty or mixed-up target is not", () => {
  const l = { t: "2026-10-24T10:00:00Z", port: 1, episode: "ep1", verb: "press", args: [], exit: 0 };
  assert.deepEqual(validateRunLogLine({ ...l, target: { selector: "#go" } }), []);
  assert.match(validateRunLogLine({ ...l, target: { selector: "" } }).join("\n"), /target\.selector/);
  assert.match(validateRunLogLine({ ...l, target: { selector: 3 } }).join("\n"), /target\.selector/);
});

const finding = () => ({ t: "2026-10-24T10:00:00Z", goal: "g1", step: 1, intent: "i", did: "d", observed: "o", expected: "x", kind: "pass" });
test("finding: valid, every kind", () => {
  for (const kind of FINDING_KINDS) assert.deepEqual(validateFindingLine({ ...finding(), kind, shot: "a.png", dup: true }), []);
});
test("finding: optional episode is a string", () => {
  assert.deepEqual(validateFindingLine({ ...finding(), episode: "ep1" }), []);
  assert.match(validateFindingLine({ ...finding(), episode: 4 }).join("\n"), /episode/);
});
test("finding: bad kind and missing t", () => {
  const f = finding(); f.kind = "maybe"; delete f.t;
  const e = validateFindingLine(f).join("\n");
  assert.match(e, /kind/); assert.match(e, /^t:/m);
});

const goal = () => ({ id: "g1", title: "Open Settings", style: "terse", scope: "vidar", surfaces: ["settings"], tags: ["nav"],
  realModel: false, core: true, steps: [{ intent: "Open it" }] });
test("goal: valid", () => assert.deepEqual(validateGoalFile(goal()), []));
test("goal: wrong scope and empty steps", () => {
  const g = goal(); g.scope = "other"; g.steps = [];
  const e = validateGoalFile(g).join("\n");
  assert.match(e, /scope/); assert.match(e, /steps/);
});
test("goal: realModel rule for model|effort|card|approval", () => {
  for (const tag of ["model", "effort", "card", "approval"]) {
    const g = goal(); g.tags = [tag];
    assert.match(validateGoalFile(g).join("\n"), /realModel/, tag);
    g.realModel = true;
    assert.deepEqual(validateGoalFile(g), [], tag);
  }
});
