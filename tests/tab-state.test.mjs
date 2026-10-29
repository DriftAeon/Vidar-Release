// Left-bar tab state (src/panels/sessions/tab-state.ts, tab-state-store.ts): chip -> phase mapping,
// relay-ask priority, `since` stamping and drop.
import test from "node:test";
import assert from "node:assert/strict";
import { deriveRendered, reasonText } from "../src/panels/sessions/tab-state.ts";
import { publish, get, subscribe, drop } from "../src/panels/sessions/tab-state-store.ts";
import { chipState } from "../src/panels/rendered/state-chip.ts";

const base = { hydrating: false, disconnected: false, isAlive: true, pendingApproval: null, inTurn: false, loggedOut: false, sessionId: null, costTotal: 0 };
const chip = (over = {}, starting = false, agents = 0) => chipState({ ...base, ...over }, starting, agents);

test("approval maps to question or permission by the pending tool", () => {
  const c = chip({ pendingApproval: {} });
  assert.deepEqual(deriveRendered(c, "AskUserQuestion", 0), { phase: "needs", reason: { kind: "question" }, tool: "AskUserQuestion" });
  assert.deepEqual(deriveRendered(c, "Bash", 0).reason, { kind: "permission", tool: "Bash" });
});

test("a relay ask outranks working and ready, not a question or a dead tab", () => {
  const w = deriveRendered(chip({ inTurn: true }), null, 2);
  assert.equal(w.phase, "needs");
  assert.deepEqual(w.reason, { kind: "relay", count: 2 });
  assert.deepEqual(deriveRendered(chip(), null, 1).reason, { kind: "relay", count: 1 });
  assert.deepEqual(deriveRendered(chip({ pendingApproval: {} }), "AskUserQuestion", 3).reason, { kind: "question" });
  const dead = deriveRendered(chip({ isAlive: false }), null, 4);
  assert.equal(dead.phase, "dead");
  assert.equal(dead.reason, null);
  assert.equal(deriveRendered(chip({ disconnected: true }), null, 0).phase, "lost");
});

test("restoring and login are unknown; working, agents, starting work; idle is ready", () => {
  assert.equal(deriveRendered(chip({ hydrating: true }), null, 0).phase, "unknown");
  assert.equal(deriveRendered(chip({ loggedOut: true }), null, 0).phase, "unknown");
  assert.equal(deriveRendered(chip({ inTurn: true }), null, 0).phase, "working");
  assert.equal(deriveRendered(chip(), null, 0).phase, "ready");
  assert.equal(deriveRendered(chip({}, false, 2), null, 0).phase, "working");
  assert.equal(deriveRendered(chip({}, true), null, 0).phase, "working");
});

test("a spawn in flight reads Starting… even once the sidecar said ready, so Ready means write() accepts", () => {
  // E1 run 3 case 2: a respawn after a vault edit showed Ready while write() refused (promptReady checks spawning)
  const inFlight = chip({ spawning: Promise.resolve() });
  assert.equal(inFlight.key, "starting");
  assert.equal(inFlight.title.split("\n")[0], "Starting…");
  assert.equal(chip({ spawning: null }).key, "ready");
  assert.equal(chip({ spawning: Promise.resolve(), hydrating: true }).key, "restoring");
  assert.equal(chip({ spawning: Promise.resolve(), isAlive: false }).key, "stopped");
});

test("since holds across same-phase publishes and re-stamps on a phase change", () => {
  publish("t1", { phase: "working" }, 100);
  assert.equal(get("t1").since, 100);
  publish("t1", { ctxPct: 40, model: "m" }, 200);
  assert.equal(get("t1").since, 100);
  assert.equal(get("t1").ctxPct, 40);
  publish("t1", { phase: "ready" }, 300);
  assert.equal(get("t1").since, 300);
  drop("t1");
});

test("drop removes the tab and notifies subscribers with null", () => {
  const seen = [];
  const off = subscribe((id, s) => seen.push([id, s]));
  publish("t2", { phase: "idle" }, 1);
  drop("t2");
  drop("t2");
  off();
  assert.equal(get("t2"), null);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], ["t2", null]);
});

test("reasonText copy is verbatim", () => {
  assert.equal(reasonText({ kind: "question" }), "Question");
  assert.equal(reasonText({ kind: "permission", tool: "Bash" }), "Permission · Bash");
  assert.equal(reasonText({ kind: "relay", count: 3 }), "Relay Ask · 3");
});
