// A replay that fails mid-way ends in `disconnected`, never `hydration: end` (host-payload.ts):
// the disconnect closes the hydration the same way the normal end does, so the tab is not left
// on "Restoring" with isBusy() true and its held cards closed.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createHostPayload, closeHydration } = await import("../src/panels/rendered/host-payload.ts");

function harness() {
  const S = { hydrating: false, replaying: false, disconnected: false, inTurn: false, costTotal: 0, characterTurnOpen: false };
  const calls = { statsEnd: 0, opened: 0, refresh: 0 };
  const root = document.createElement("div");
  const deps = {
    opts: { tabId: "t1" },
    transport: {},
    root,
    follow: { jump() {} },
    textarea: document.createElement("textarea"),
    approvals: new Map(),
    cancelApprovals() {},
    alreadyAnswered: () => false,
    resetTranscript() {},
    resetCache() {},
    setInTurn: (v) => { S.inTurn = v; },
    append: (n) => root.appendChild(n),
    sealGroup() {},
    noticeBlock() {},
    refreshState: () => { calls.refresh++; },
    emitCharacterStatus() {},
    interrupt() {},
    stats: { start() {}, record() {}, end: () => { calls.statsEnd++; } },
    openHydratedCards: () => { calls.opened++; },
    tools: new Map(),
    stalePill: (t) => { calls.staled.push(t); },
  };
  calls.staled = [];
  return { S, root, calls, deps, hp: createHostPayload(S, deps) };
}

test("a disconnect mid-replay stale-marks the pills still open, not the finished ones", () => {
  const h = harness();
  const pill = (cls) => { const details = document.createElement("details"); if (cls) details.classList.add(cls); return { details, group: null }; };
  const open = ["running", "pending", "awaiting"].map(pill);
  for (const [i, t] of [...open, pill("done")].entries()) h.deps.tools.set(`u${i}`, t);
  h.hp.hostPayload({ hydration: "start" });
  h.hp.hostPayload({ disconnected: "pipe closed" });
  assert.deepEqual(h.calls.staled, open);
});

test("a disconnect mid-hydration clears inTurn first, so the open pills are swept", () => {
  const h = harness();
  const details = document.createElement("details");
  details.classList.add("running");
  const pill = { details, group: null };
  h.deps.tools.set("u0", pill);
  h.hp.hostPayload({ hydration: "start" }); // start itself clears inTurn
  h.S.inTurn = true; // the replay is mid-turn when the pipe drops
  h.hp.hostPayload({ disconnected: "pipe closed" });
  assert.equal(h.S.inTurn, false, "inTurn left set");
  assert.deepEqual(h.calls.staled, [pill], "running pill not stale-marked");
});

test("disconnect during hydration ends it: flags clear, meter closes, held cards open", () => {
  const h = harness();
  h.hp.hostPayload({ hydration: "start" });
  assert.equal(h.S.hydrating, true);
  assert.equal(h.root.inert, true);

  h.hp.hostPayload({ disconnected: "read from falcon: broken pipe" });
  assert.equal(h.S.hydrating, false, "still hydrating after the disconnect");
  assert.equal(h.S.replaying, false);
  assert.equal(h.S.disconnected, true);
  assert.equal(h.root.inert, false);
  assert.equal(h.calls.statsEnd, 1, "meter left open");
  assert.equal(h.calls.opened, 1, "held cards never opened");
});

test("disconnect outside hydration touches neither the meter nor the cards", () => {
  const h = harness();
  h.hp.hostPayload({ disconnected: "read from falcon: broken pipe" });
  assert.equal(h.S.disconnected, true);
  assert.equal(h.calls.statsEnd, 0);
  assert.equal(h.calls.opened, 0);
});

test("a disconnect mid-turn outside hydration stale-marks the open pills", () => {
  const h = harness();
  const pill = (cls) => { const details = document.createElement("details"); details.classList.add(cls); return { details, group: null }; };
  const open = pill("running");
  h.deps.tools.set("u0", open);
  h.deps.tools.set("u1", pill("done"));
  h.S.inTurn = true; // live turn, no hydration open
  h.hp.hostPayload({ disconnected: "pipe closed" });
  assert.equal(h.S.inTurn, false);
  assert.deepEqual(h.calls.staled, [open], "running pill left running after the disconnect");
});

test("a dispatch for a prompt the replay never showed still starts the turn", () => {
  const h = harness();
  h.hp.hostPayload({ hydration: "start" });
  h.hp.hostPayload({ hostRecord: { body: { record: "prompt-dispatched", prompt: "unseen" } } });
  assert.equal(h.S.inTurn, true);
});

test("closeHydration sweeps open pills only when no live turn is in flight", () => {
  const stats = { end() {} };
  let swept = 0;
  const sweep = () => { swept++; };
  closeHydration({ hydrating: true, replaying: true, inTurn: false }, stats, () => {}, sweep);
  assert.equal(swept, 1, "finished turn left its pills running");
  closeHydration({ hydrating: true, replaying: true, inTurn: true }, stats, () => {}, sweep);
  assert.equal(swept, 1, "a live turn's pills must stay");
  closeHydration({ hydrating: false, replaying: false, inTurn: false }, stats, () => {}, sweep);
  assert.equal(swept, 1, "no hydration was open");
});

test("disconnect closes the character turn", () => {
  const h = harness();
  h.S.characterTurnOpen = true;
  h.hp.hostPayload({ disconnected: "broken pipe" });
  assert.equal(h.S.characterTurnOpen, false);
});

test("closeHydration reports whether a hydration was open", () => {
  const S = { hydrating: true, replaying: true };
  let ended = 0;
  let opened = 0;
  const stats = { end: () => { ended++; } };
  assert.equal(closeHydration(S, stats, () => { opened++; }), true);
  assert.equal(closeHydration(S, stats, () => { opened++; }), false);
  assert.deepEqual([S.hydrating, S.replaying, ended, opened], [false, false, 1, 1]);
});
