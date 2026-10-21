// A background subagent that ends its turn waiting on its own background Bash is parked: the CLI
// (0.3.266) drops it from background_tasks_changed while the child stays listed and sends a
// "completed" task_updated + task_notification; when the child ends it re-lists the agent, which
// later finishes with a second notification. Sequence observed with a headless SDK probe
// (2026-10-16). The row stays running through the park and settles on the final notification
// (claude.ts subagentOwned -> agents-block.ts liveTasks / taskDone).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({ answers: { patch_state: null } });
dom.window.setInterval = (fn, ms) => setInterval(fn, ms);
const { ClaudeAdapter } = await import("../src/agents/claude.ts");
const { createAgentsBlock, DRAIN_SETTLE_MS } = await import("../src/panels/rendered/agents-block.ts");

const AGENT = "a2fd585624e0d8535";
const BASH = "bs2zzeqx9";
const sys = (subtype, rest) => JSON.stringify({ type: "system", subtype, ...rest, uuid: "u", session_id: "s" });
const live = (...ids) => sys("background_tasks_changed", { tasks: ids.map(([id, type]) => ({ task_id: id, task_type: type, description: "d" })) });
const started = (id, type, owned) => sys("task_started", { task_id: id, task_type: type, is_backgrounded: true, ...(owned ? { owned_by_subagent: true } : {}) });
const updated = (id, status) => sys("task_updated", { task_id: id, patch: { status, end_time: 1 } });
const notified = (id, status, summary) => sys("task_notification", { task_id: id, status, summary, output_file: "" });

function setup() {
  const S = { sessionId: "sess-1", replaying: false, waitingTimer: undefined };
  const b = createAgentsBlock(S, { tools: new Map(), noticeBlock: () => {}, refreshState: () => {} });
  document.body.appendChild(b.el);
  const adapter = new ClaudeAdapter();
  // the events.ts routing of the two kinds this covers
  const feed = (line) => {
    for (const ev of adapter.feed(line)) {
      if (ev.kind === "tasks_live") b.liveTasks(ev.taskIds, ev.subagentOwned ?? [], ev.subagentOwners);
      else if (ev.kind === "task" && ev.phase === "done") b.taskDone(ev.taskId, ev.status, ev.summary, ev.report, ev.tokens, ev.fromUpdate);
    }
  };
  return { b, feed };
}

test("a subagent parked on its own background Bash keeps running and settles on the final notification", () => {
  const { b, feed } = setup();
  feed(live([AGENT, "local_agent"]));
  feed(started(AGENT, "local_agent", false));
  b.addWaiting(AGENT, undefined);
  const w = b.waiting.get(AGENT);
  w.since -= 5_000;

  feed(live([AGENT, "local_agent"], [BASH, "local_bash"]));
  feed(started(BASH, "local_bash", true));
  // the park: the agent leaves the set, its child stays, and the CLI reports it completed
  feed(live([BASH, "local_bash"]));
  feed(updated(AGENT, "completed"));
  feed(notified(AGENT, "completed", "Command started in background. Waiting for completion"));
  assert.equal(w.done, false, "the park closed the row");
  assert.equal(w.row.dataset.state, "running");
  assert.equal(b.runningCount(), 1);

  // the child ends, then the agent is listed again (it woke)
  feed(live());
  feed(updated(BASH, "completed"));
  feed(notified(BASH, "completed", "Background command completed"));
  assert.equal(w.done, false, "the child's end closed the row before the wake");
  feed(live([AGENT, "local_agent"]));
  feed(started(AGENT, "local_agent", false));
  assert.equal(w.done, false);
  assert.equal(w.parked, undefined, "the wake left the row parked");

  // the real finish
  feed(live());
  feed(updated(AGENT, "completed"));
  feed(notified(AGENT, "completed", "FINISHED"));
  assert.equal(w.done, true, "the final notification did not settle the row");
  assert.equal(w.failed, false);
  assert.equal(w.row.dataset.state, "done");
  assert.equal(b.runningCount(), 0);
  b.dispose();
});

test("absence with no subagent-started task live still closes the row", () => {
  const { b, feed } = setup();
  b.addWaiting(AGENT, undefined);
  feed(live([AGENT, "local_agent"]));
  feed(live([BASH, "local_bash"])); // a main-thread Bash, not the subagent's
  assert.equal(b.waiting.get(AGENT).done, true);
  b.dispose();
});

test("a parked agent that never wakes settles with its held notice once its children are gone", () => {
  const { b, feed } = setup();
  b.addWaiting(AGENT, undefined);
  const w = b.waiting.get(AGENT);
  feed(live([AGENT, "local_agent"], [BASH, "local_bash"]));
  feed(started(BASH, "local_bash", true));
  feed(live([BASH, "local_bash"]));
  feed(notified(AGENT, "completed", "Parked"));
  feed(live()); // children gone: the next set decides
  assert.equal(w.done, false);
  feed(live(["other", "local_bash"]));
  assert.equal(w.done, true, "a parked row that never re-listed stayed running");
  b.dispose();
});

// C1: B's subagent started a long background Bash (its task_started names B's own tool call,
// whose parent_tool_use_id is B's Agent call); A finishing meanwhile is not parked on it.
const subagentToolUse = (parent, id) => JSON.stringify({ type: "assistant", parent_tool_use_id: parent,
  message: { id: "m-" + id, content: [{ type: "tool_use", id, name: "Bash", input: { command: "x", run_in_background: true } }] }, session_id: "s" });
const startedBy = (id, call) => sys("task_started", { task_id: id, task_type: "local_bash", is_backgrounded: true, owned_by_subagent: true, tool_use_id: call });

test("another agent's live shell does not park a finished agent (owner resolved)", () => {
  const { b, feed } = setup();
  const A = "aaaaaaaa11111111", B = "bbbbbbbb22222222";
  b.addWaiting(A, "toolA");
  b.addWaiting(B, "toolB");
  const wa = b.waiting.get(A), wb = b.waiting.get(B);
  feed(live([A, "local_agent"], [B, "local_agent"]));
  feed(subagentToolUse("toolB", "bashCallB"));
  feed(startedBy(BASH, "bashCallB"));
  feed(live([A, "local_agent"], [B, "local_agent"], [BASH, "local_bash"]));
  // A leaves the set before its notification; B and its shell stay
  feed(live([B, "local_agent"], [BASH, "local_bash"]));
  feed(notified(A, "completed", "A done"));
  assert.equal(wa.done, true, "A was parked on B's shell");
  assert.equal(wa.parked, undefined);
  // B parks on its own shell exactly as before
  feed(live([BASH, "local_bash"]));
  feed(notified(B, "completed", "Parked"));
  assert.equal(wb.done, false);
  assert.ok(wb.parked);
  b.dispose();
});

test("an unresolved owner keeps today's park for every absent row", () => {
  const { b, feed } = setup();
  const A = "aaaaaaaa11111111";
  b.addWaiting(A, "toolA");
  const wa = b.waiting.get(A);
  feed(live([A, "local_agent"], [BASH, "local_bash"]));
  feed(started(BASH, "local_bash", true)); // no tool_use_id: owner unknown
  feed(live([BASH, "local_bash"]));
  feed(notified(A, "completed", "Parked"));
  assert.equal(wa.done, false);
  b.dispose();
});

// C4: the shell ends, the CLI never wakes the agent and sends no further set: the drain set's
// timer settles it with the held notice instead of leaving it running until Clear.
test("a drained park with no further set settles after the drain wait", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { b, feed } = setup();
  b.addWaiting(AGENT, undefined);
  const w = b.waiting.get(AGENT);
  feed(live([AGENT, "local_agent"], [BASH, "local_bash"]));
  feed(started(BASH, "local_bash", true));
  feed(live([BASH, "local_bash"]));
  feed(notified(AGENT, "completed", "Parked"));
  feed(live()); // drained; nothing follows
  assert.equal(w.done, false, "the drain set settled before a wake could come");
  t.mock.timers.tick(DRAIN_SETTLE_MS - 1);
  assert.equal(w.done, false);
  t.mock.timers.tick(1);
  assert.equal(w.done, true, "a drained park never settled");
  assert.equal(w.failed, false);
  b.dispose();
});

test("a wake inside the drain wait keeps the row running past it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { b, feed } = setup();
  b.addWaiting(AGENT, undefined);
  const w = b.waiting.get(AGENT);
  feed(live([AGENT, "local_agent"], [BASH, "local_bash"]));
  feed(started(BASH, "local_bash", true));
  feed(live([BASH, "local_bash"]));
  feed(notified(AGENT, "completed", "Parked"));
  feed(live());
  feed(live([AGENT, "local_agent"])); // woke
  t.mock.timers.tick(DRAIN_SETTLE_MS);
  assert.equal(w.done, false, "a stale drain timer settled a woken row");
  b.dispose();
});

test("a kill while parked settles it from task_updated", () => {
  const { b, feed } = setup();
  b.addWaiting(AGENT, undefined);
  const w = b.waiting.get(AGENT);
  feed(live([AGENT, "local_agent"], [BASH, "local_bash"]));
  feed(started(BASH, "local_bash", true));
  feed(live([BASH, "local_bash"]));
  feed(notified(AGENT, "completed", "Parked"));
  feed(updated(AGENT, "killed"));
  assert.equal(w.done, true);
  assert.equal(w.failed, true);
  b.dispose();
});
