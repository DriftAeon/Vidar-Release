// ctl.prompt and ctl.spawn on the approval registry: each outcome (approve, deny with a comment, expire)
// yields exactly one reply line; cancel (ctl-card-cancel) is silent and starts nothing. ctl.spawn starts
// the agent only after approve.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

globalThis.__lines = [];
globalThis.__spawned = 0;
globalThis.__prompted = 0;
const { ipc } = setupDom({
  answers: { control_result: (args) => { globalThis.__lines.push(args); } },
  stubs: {
    "panels/sessions": "export const sessionTitle = () => null;",
    "control/registry": `export const driveSnapshot = () => ({ tabs: [{ id: "t1", body: "rendered" }] });
      export const showDocument = async () => {}; export const showDisplay = async () => {}; export const focusTarget = () => true;
      export const resolveTab = (t) => t; export const requesterTabId = () => (globalThis.__gone ? null : (globalThis.__req ?? "req")); export const readTranscript = async () => "";
      export const promptTab = async () => { globalThis.__prompted++; return true; };
      export const spawnTab = async () => { globalThis.__spawned++; return "t9"; };
      export const hasRenderedAgent = () => true; export const hostedRenderedAgent = () => true;
      export const hostedTab = () => globalThis.__hosted === true; export const tabPromptReady = () => true; export const tabBusy = () => false;
      export const tabDead = () => false; export const sendPromptTo = async () => {}; export const laneToast = () => {};`,
    "control/watch": "export const watchTab = () => {};",
    "control/flow": "export const handleFlowCard = () => {}; export const listenFlowObserve = () => {};",
    "flow/approvals-relay": "export const startFlowApprovalRelay = () => {};",
    "relay/source-ctl-asks": "export const publishCtlAsk = () => null; export const hostedClaudeAsker = () => false; export const CTL_ASK_STEER = '';",
  },
});
await import("../src/control/listen.ts");
const { liveApprovals } = await import("../src/asks/approvals.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
async function card(verb, details, ttlMs = 120_000) {
  const cardId = String(1000 + ++seq);
  globalThis.__lines.length = 0;
  await ipc.listeners["ctl-card"]({ payload: {
    id: `req-${cardId}`, cardId, verb, requester: { kind: "falcon_session" }, details, claimedAtMs: Date.now(), expiresAtMs: Date.now() + ttlMs,
  } });
  return cardId;
}
const entry = (cardId) => liveApprovals().find((e) => e.record.id === cardId);
const promptDetails = { tab: "t1", text: "hello" };
const spawnDetails = { agent: "claude", model: "m1", text: "go" };

test("ctl.prompt approve delivers once; a second answer is refused", async () => {
  globalThis.__prompted = 0;
  const cardId = await card("prompt", promptDetails);
  const e = entry(cardId);
  assert.equal(e.record.comment, true);
  assert.equal(e.record.asker.verified, true);
  await e.answer({ verdict: "approve", comment: "", where: "Relay" });
  await tick(10);
  await assert.rejects(e.answer({ verdict: "approve", comment: "", where: "Relay" }), /Already Answered/);
  assert.equal(globalThis.__prompted, 1);
  assert.deepEqual(globalThis.__lines.map((l) => l.line), ["delivered t1"]);
});

test("ctl.prompt deny replies denied with the Relay comment, once", async () => {
  const cardId = await card("prompt", promptDetails);
  await entry(cardId).answer({ verdict: "deny", comment: "not now", where: "Relay" });
  await tick(10);
  assert.deepEqual(globalThis.__lines.map((l) => l.line), ["denied not now"]);
});

test("ctl.prompt expiry replies err expired once", async () => {
  const cardId = await card("prompt", promptDetails, 40);
  await tick(120);
  assert.equal(entry(cardId), undefined);
  assert.deepEqual(globalThis.__lines.map((l) => l.line), ["err expired"]);
});

test("ctl.prompt cancel is silent and frees the slot", async () => {
  const cardId = await card("prompt", promptDetails);
  ipc.listeners["ctl-card-cancel"]({ payload: { cardId } });
  await tick(10);
  assert.equal(entry(cardId), undefined);
  assert.deepEqual(globalThis.__lines, []);
  const next = await card("prompt", promptDetails);
  assert.ok(entry(next), "a new ask for the same asker opens after the cancel");
  await entry(next).answer({ verdict: "deny", comment: "", where: "Relay" });
  await tick(10);
});

test("ctl.spawn starts the agent only after approve, once", async () => {
  globalThis.__spawned = 0;
  const denied = await card("spawn", spawnDetails);
  await entry(denied).answer({ verdict: "deny", comment: "no", where: "Relay" });
  await tick(10);
  assert.deepEqual(globalThis.__lines.map((l) => l.line), ["denied no"]);
  assert.equal(globalThis.__spawned, 0);

  const expired = await card("spawn", spawnDetails, 40);
  await tick(120);
  assert.deepEqual(globalThis.__lines.map((l) => l.line), ["err expired"]);
  assert.equal(entry(expired), undefined);

  const cancelled = await card("spawn", spawnDetails);
  ipc.listeners["ctl-card-cancel"]({ payload: { cardId: cancelled } });
  await tick(10);
  assert.deepEqual(globalThis.__lines, []);
  assert.equal(globalThis.__spawned, 0);

  const ok = await card("spawn", spawnDetails);
  await entry(ok).answer({ verdict: "approve", comment: "", where: "Relay" });
  await tick(20);
  assert.equal(globalThis.__spawned, 1);
  assert.equal(globalThis.__lines.length, 1);
  assert.match(globalThis.__lines[0].line, /^spawned t9 prompted/);
});

// Notify lanes: every non-delivering outcome releases the reserved lane, so a fresh reserve for the same
// deliverTo succeeds (a leaked lease would answer "busy"). Needs a hosted target tab.
const notifyPrompt = { tab: "t1", text: "hello", notify: true, deliver_to: "req" };
const notifySpawn = { agent: "claude", model: "m1", text: "go", notify: true, deliver_to: "req" };
// reserve() refuses only past LANE_CAP (4) outstanding leases, so one fresh reserve proves nothing: open
// LANE_CAP notify cards (distinct askers, same deliverTo) and require all to open; a leaked lease busies the last.
const LANE_CAP = 4;
async function freshReserve(label) {
  const ids = [];
  try {
    for (let i = 0; i < LANE_CAP; i++) {
      globalThis.__req = `ask${i}`;
      const cardId = await card("prompt", notifyPrompt);
      assert.ok(entry(cardId), `${label}: reserve ${i + 1} of ${LANE_CAP} for the same deliverTo opens`);
      assert.deepEqual(globalThis.__lines, [], `${label}: no refusal line`);
      ids.push(cardId);
    }
  } finally {
    globalThis.__req = undefined;
    for (const id of ids) if (entry(id)) await entry(id).answer({ verdict: "deny", comment: "", where: "Relay" });
    await tick(10);
  }
}

test("notify lanes free the lease after deny, expire, cancel, busy and a late approve", async () => {
  globalThis.__hosted = true;
  try {
    const denied = await card("prompt", notifyPrompt);
    await entry(denied).answer({ verdict: "deny", comment: "no", where: "Relay" });
    await tick(10);
    await freshReserve("deny");

    await card("prompt", notifyPrompt, 40);
    await tick(120);
    await freshReserve("expire");

    const cancelled = await card("prompt", notifyPrompt);
    ipc.listeners["ctl-card-cancel"]({ payload: { cardId: cancelled } });
    await tick(10);
    await freshReserve("cancel");

    const first = await card("prompt", notifyPrompt);
    await card("prompt", notifyPrompt); // busy refusal releases its own lease
    await entry(first).answer({ verdict: "deny", comment: "", where: "Relay" });
    await tick(10);
    await freshReserve("busy");

    const late = await card("prompt", notifyPrompt, 20_000); // under LATE_APPROVE_MS
    await entry(late).answer({ verdict: "approve", comment: "", where: "Relay" });
    await tick(10);
    assert.deepEqual(globalThis.__lines.map((l) => l.line), ["err expired"]);
    await freshReserve("late approve");
  } finally { globalThis.__hosted = false; }
});

test("ctl.spawn late approve starts nothing and replies one err line", async () => {
  globalThis.__spawned = 0;
  const late = await card("spawn", spawnDetails, 20_000);
  await entry(late).answer({ verdict: "approve", comment: "", where: "Relay" });
  await tick(20);
  assert.equal(globalThis.__spawned, 0);
  assert.deepEqual(globalThis.__lines.map((l) => l.line), ["err expired"]);
});

test("approve after the requester is gone starts nothing and replies err requester gone", async () => {
  globalThis.__prompted = 0;
  globalThis.__spawned = 0;
  for (const [verb, details] of [["prompt", promptDetails], ["spawn", spawnDetails]]) {
    const cardId = await card(verb, details);
    globalThis.__gone = true;
    await entry(cardId).answer({ verdict: "approve", comment: "", where: "Relay" });
    await tick(20);
    globalThis.__gone = false;
    assert.deepEqual(globalThis.__lines.map((l) => l.line), ["err requester gone"], verb);
  }
  assert.equal(globalThis.__prompted, 0);
  assert.equal(globalThis.__spawned, 0);
});

test("a second ctl.prompt from the same asker gets the busy refusal", async () => {
  const first = await card("prompt", promptDetails);
  const second = await card("prompt", promptDetails);
  assert.deepEqual(globalThis.__lines.map((l) => l.line), ['err an ask for "ctl-prompt" is already on screen or queued; only one at a time is useful']);
  assert.equal(entry(second), undefined);
  await entry(first).answer({ verdict: "deny", comment: "", where: "Relay" });
  await tick(10);
});
