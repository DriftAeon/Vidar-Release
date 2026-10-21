// A SendMessage that resumes a finished background agent reopens its row in the agents bar
// (claude.ts `resumedAgentId` -> task "resumed" -> agents-block.ts resumeWaiting); a SendMessage to
// a live peer stays an ordinary pill. Replayed history parses the same as live.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({ answers: { patch_state: null } }); // Clear persists the dismissed ids
// the block starts its tick with window.setInterval and stops it with the global clearInterval:
// one timer system here, or jsdom's interval outlives dispose and the run never exits
dom.window.setInterval = (fn, ms) => setInterval(fn, ms);
const { ClaudeAdapter } = await import("../src/agents/claude.ts");
const { createAgentsBlock } = await import("../src/panels/rendered/agents-block.ts");

const ID = "ac9c67b6325e383f1";
const RESUMED = JSON.stringify({ success: true, message: "Resuming agent ac9c67b", resumedAgentId: ID, pin: { id: ID, name: ID, ref: "cc5046" } });
const PEER = JSON.stringify({ success: true, message: "Message sent to vidar-f2" });
const result = (toolUseId, text, replay = false) =>
  JSON.stringify({ type: "user", ...(replay ? { replay: true } : {}), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] }] } });
const tasks = (evs) => evs.filter((e) => e.kind === "task");

test("a SendMessage result with resumedAgentId is a resumed task, live and replayed alike", () => {
  const live = tasks(new ClaudeAdapter().feed(result("toolu_S", RESUMED)));
  assert.deepEqual(live, [{ kind: "task", phase: "resumed", taskId: ID, toolUseId: "toolu_S" }]);
  const replayed = tasks(new ClaudeAdapter().feed(result("toolu_S", RESUMED, true)));
  assert.deepEqual(replayed, live, "replay parsed the resume differently from live");
});

test("a peer SendMessage without resumedAgentId emits no task event (no row)", () => {
  assert.deepEqual(tasks(new ClaudeAdapter().feed(result("toolu_P", PEER))), []);
  assert.deepEqual(tasks(new ClaudeAdapter().feed(result("toolu_P", "not json {resumedAgentId"))), []);
});

function record(subagentType, subagentDesc) {
  const details = document.createElement("details");
  details.appendChild(document.createElement("summary"));
  return { details, out: null, children: null, name: "x", group: null, card: null, subagentType, subagentDesc };
}
function block() {
  const tools = new Map();
  const S = { sessionId: "sess-1", replaying: false, waitingTimer: undefined };
  const b = createAgentsBlock(S, { tools, noticeBlock: () => {}, refreshState: () => {} });
  document.body.appendChild(b.el);
  return { b, tools, S };
}
const text = (root, sel) => root.querySelector(sel)?.textContent ?? "";

test("a resume reopens the matched row; its completion finishes it with the new report", () => {
  const { b, tools } = block();
  tools.set("toolu_A", record("Striker", "First Task"));
  b.addWaiting(ID, "toolu_A");
  b.removeWaiting(ID, "completed", undefined, "First report");
  const w = b.waiting.get(ID);
  assert.equal(w.done, true);
  w.since -= 60_000; // the first run took a minute

  tools.set("toolu_S", record(ID, "Follow-up check"));
  b.resumeWaiting(ID, "toolu_S");
  assert.equal(b.waiting.size, 1, "the resume added a second row");
  assert.equal(w.done, false);
  assert.equal(w.row.dataset.state, "running");
  assert.equal(text(w.row, ".agent-word"), "Running");
  assert.equal(text(w.row, ".agent-desc"), "Follow-up check", "the summary is not the sub-line");
  assert.equal(text(w.row, ".agent-time"), "0:00", "elapsed did not restart");
  assert.equal(w.row.classList.contains("done"), false);
  assert.equal(b.runningCount(), 1);

  // the previous report stays reachable in the drawer while it runs
  w.row.click();
  const fold = b.el.querySelector(".agent-drawer .agent-fold");
  assert.equal(fold.hidden, false, "the previous report fold is hidden");
  assert.match(text(b.el, ".agent-drawer .agent-report"), /First report/);

  b.removeWaiting(ID, "completed", undefined, "Second report");
  assert.equal(w.done, true);
  assert.equal(w.report, "Second report", "the new report did not replace the old one");
  assert.equal(text(w.row, ".agent-word"), "Done");
  assert.equal(text(w.row, ".agent-desc"), "Second report");
  assert.match(text(b.el, ".agent-drawer .agent-report"), /Second report/);
  b.dispose();
});

test("a resume with no matching row adds one labelled with the target and the summary", () => {
  const { b, tools } = block();
  tools.set("toolu_S", record(ID, "Follow-up check"));
  b.resumeWaiting(ID, "toolu_S");
  const w = b.waiting.get(ID);
  assert.ok(w, "no row was added");
  assert.equal(w.label, ID);
  assert.equal(w.title, "Follow-up check");
  assert.equal(w.done, false);
  b.removeWaiting(ID, "completed", undefined, "Done report");
  assert.equal(w.done, true);
  b.dispose();
});

test("a resume replayed for a cleared agent stays hidden; a live one brings it back", async (t) => {
  const { b, tools, S } = block();
  t.after(() => b.dispose());
  const mm = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true }); // reduced motion: Clear skips its fade (no animate in jsdom)
  t.after(() => { globalThis.matchMedia = mm; });
  tools.set("toolu_S", record(ID, "Follow-up check"));
  tools.set("toolu_A", record("Striker", "First Task"));
  // the dismissed store is the real pref: seed it through the block's own Clear
  b.addWaiting(ID, "toolu_A");
  b.removeWaiting(ID, "completed");
  b.el.querySelector(".agents-clear-done").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(b.waiting.size, 0, "Clear left the row");
  S.replaying = true;
  b.resumeWaiting(ID, "toolu_S");
  assert.equal(b.waiting.size, 0, "a replayed resume brought a cleared row back");
  S.replaying = false;
  b.resumeWaiting(ID, "toolu_S");
  assert.equal(b.waiting.size, 1, "a live resume of a cleared agent added no row");
  b.dispose();
});
