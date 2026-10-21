// A resume's sidecar history replay carries an Agent launch but never its hand-back, so the row
// would stay running and the chip read "Waiting on agents". The replay-end branch settles replayed
// rows (events.ts -> agents-block.ts settleReplayedAgents). Path under test: adapter -> events -> block.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({ answers: { patch_state: null } });
dom.window.setInterval = (fn, ms) => setInterval(fn, ms); // one timer system, see rendered-agents-resume
const { ClaudeAdapter } = await import("../src/agents/claude.ts");
const { createAgentsBlock } = await import("../src/panels/rendered/agents-block.ts");
const { createEvents } = await import("../src/panels/rendered/events.ts");
const { chipState } = await import("../src/panels/rendered/state-chip.ts");

const ID = "abc12345def67890";
const LAUNCH = `Async agent launched successfully.\nagentId: ${ID} (internal ID)`;
const RESUMED = JSON.stringify({ success: true, message: "Resuming agent abc1234", resumedAgentId: ID });
const result = (toolUseId, text, replay) =>
  JSON.stringify({ type: "user", ...(replay ? { replay: true } : {}), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] }] } });
const marker = (sub, count = 3) => JSON.stringify({ type: "sidecar", subtype: sub, count });

function rig(hydrating = false) {
  const tools = new Map();
  const S = {
    sessionId: "sess-1", replaying: false, hydrating, turnGroups: [], stick: false, waitingTimer: undefined,
    isAlive: true, disconnected: false, pendingApproval: false, inTurn: false, loggedOut: false,
  };
  const b = createAgentsBlock(S, { tools, noticeBlock: () => {}, refreshState: () => {} });
  document.body.appendChild(b.el);
  const noop = () => {};
  const { handle } = createEvents(S, {
    opts: { agent: "claude" }, tools, sealGroup: noop, follow: { jump: noop }, restoredBlock: noop,
    stalePill: noop, noticeBlock: noop, toolDone: noop, toolStart: noop, toolPending: noop,
    addWaiting: b.addWaiting, resumeWaiting: b.resumeWaiting, taskDone: b.taskDone, liveTasks: b.liveTasks,
    clearWaiting: b.clearWaiting, settleDoneAgents: b.settleDoneAgents, settleReplayedAgents: b.settleReplayedAgents,
  });
  const adapter = new ClaudeAdapter();
  const feed = (line) => { for (const ev of adapter.feed(line)) handle(ev); };
  const chip = () => chipState(S, false, b.runningCount()).key;
  return { b, S, feed, chip };
}

test("a replayed launch is settled at replay end: no running row, chip not waiting", () => {
  const { b, feed, chip } = rig();
  feed(marker("replaying"));
  feed(result("toolu_A", LAUNCH, true));
  assert.equal(b.runningCount(), 1, "the replayed launch builds a running row first");
  feed(marker("replayed"));
  assert.equal(b.runningCount(), 0);
  assert.notEqual(chip(), "agents");
  const w = b.waiting.get(ID);
  assert.equal(w.done, true);
  assert.equal(w.failed, false);
  assert.equal(w.elapsedFrozen, "", "a settled row shows no elapsed");
  assert.equal(w.row.querySelector(".agent-time")?.textContent ?? "", "");
});

test("the same under hydration (Falcon re-adopt order)", () => {
  const { b, S, feed, chip } = rig(true);
  feed(marker("replaying"));
  feed(result("toolu_A", LAUNCH, true));
  feed(marker("replayed"));
  assert.equal(b.runningCount(), 0);
  S.hydrating = false;
  assert.notEqual(chip(), "agents");
});

test("a launch after the replay end marker stays running", () => {
  const { b, feed, chip } = rig();
  feed(marker("replaying"));
  feed(marker("replayed"));
  feed(result("toolu_B", LAUNCH, false));
  assert.equal(b.runningCount(), 1);
  assert.equal(chip(), "agents");
  b.dispose();
});

test("a live resume of a settled row reopens it", () => {
  const { b, feed } = rig();
  feed(marker("replaying"));
  feed(result("toolu_A", LAUNCH, true));
  feed(marker("replayed"));
  assert.equal(b.runningCount(), 0);
  feed(result("toolu_S", RESUMED, false));
  assert.equal(b.runningCount(), 1);
  assert.equal(b.waiting.get(ID).done, false);
  b.dispose();
});

test("a second replay end is a no-op", () => {
  const { b, feed } = rig();
  feed(marker("replaying"));
  feed(result("toolu_A", LAUNCH, true));
  feed(marker("replayed"));
  const w = b.waiting.get(ID);
  feed(marker("replayed"));
  feed(marker("replayed"));
  assert.equal(b.runningCount(), 0);
  assert.equal(b.waiting.size, 1);
  assert.equal(b.waiting.get(ID), w);
  assert.equal(w.done, true);
  assert.equal(w.elapsedFrozen, "");
});
