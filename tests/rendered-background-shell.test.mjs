// A background shell (Bash / PowerShell run_in_background, or moved to the background at its
// timeout) returns its tool_result at once; the pill stays armed (the Monitor spinner) until the task
// ends: a task_notification, leaving background_tasks_changed, a terminal task_updated, or the
// session ending (monitor-watch.ts armShell, monitor-run.ts). Wire shapes from Falcon journals and
// transcripts, 2026-10-16. A subagent's shell pill is armed under its Agent pill, never on the main chain.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom();
dom.window.setInterval = (fn, ms) => setInterval(fn, ms);
globalThis.CSS ??= { escape: (s) => String(s) }; // chain.ts builds selectors with CSS.escape
const W = await import("../src/panels/rendered/monitor-watch.ts");
const { createMonitorRun } = await import("../src/panels/rendered/monitor-run.ts");
const { renderChain } = await import("../src/panels/rendered/chain.ts");
const { ClaudeAdapter } = await import("../src/agents/claude.ts");

const TASK = "b7tg0m496";
const TU = "toolu_014dxFENbMpDQbWbHKNHsg92";
const BG = `Command running in background with ID: ${TASK}. Output is being written to: C:\\tmp\\tasks\\${TASK}.output. You will be notified when it completes.`;
const MOVED = `Command did not complete within its 120s timeout and was moved to the background (ID: ${TASK}). Output is being written to: C:\\tmp\\x.output.`;

const sys = (subtype, rest) => JSON.stringify({ type: "system", subtype, ...rest, uuid: "u", session_id: "s" });
const live = (...ids) => sys("background_tasks_changed", { tasks: ids.map((id) => ({ task_id: id, task_type: "local_bash", description: "Write audit" })) });
const notified = (status) => sys("task_notification", { task_id: TASK, tool_use_id: TU, status, output_file: "", summary: `Background command "Write audit" ${status} (exit code 0)` });
const updated = (status) => sys("task_updated", { task_id: TASK, patch: { status, end_time: 1 } });

function pill(name, toolUseId) {
  const details = document.createElement("details");
  details.className = "blk blk-tool";
  details.dataset.tool = name;
  const summary = document.createElement("summary");
  const badge = document.createElement("span");
  badge.className = "tool-badge";
  const img = document.createElement("img");
  img.className = "icn";
  badge.appendChild(img);
  summary.appendChild(badge);
  details.appendChild(summary);
  return { details, out: null, children: null, name, group: null, card: null, toolUseId };
}

function setup(nested = false) {
  const S = { sessionId: "s", replaying: false, disposed: false };
  const gd = document.createElement("details");
  gd.appendChild(document.createElement("summary"));
  const g = { details: gd, label: document.createElement("span"), counts: new Map(), sealed: false, error: false, userToggled: false, thinking: new Set() };
  const tools = new Map();
  const shell = pill("Bash", TU);
  shell.group = g;
  if (nested) {
    const agent = pill("Agent", "toolu_agent");
    agent.children = document.createElement("div");
    agent.children.className = "tool-children";
    agent.details.appendChild(agent.children);
    agent.children.appendChild(shell.details);
    gd.appendChild(agent.details);
    tools.set("toolu_agent", agent);
    g.counts.set("Agent", 1);
  } else {
    gd.appendChild(shell.details);
    g.counts.set("Bash", 1);
  }
  tools.set(TU, shell);
  const run = createMonitorRun(S, { tools, groupRefresh: (grp) => renderChain(grp, "claude", false) });
  const adapter = new ClaudeAdapter();
  // the events.ts routing of the kinds this covers
  const feed = (line) => {
    for (const ev of adapter.feed(line)) {
      if (ev.kind === "tasks_live") run.onTasksLive(ev.taskIds);
      else if (ev.kind === "task" && ev.phase === "done") run.onTaskDone(ev);
    }
  };
  run.onToolStart(TU, "Bash", { command: "pwsh -File write-audit.ps1", description: "Write audit", run_in_background: true });
  const state = () => shell.details.dataset.monitor;
  const title = () => shell.details.querySelector(".tool-badge").title;
  const seg = () => g.label.querySelector('.chain-seg[data-tool="Bash"]');
  return { S, g, run, feed, state, title, seg };
}

test("both background result phrasings arm; a foreground or failed result does not", () => {
  assert.equal(W.armShell(TU, "Bash", BG, false).taskId, TASK);
  assert.equal(W.armShell(TU, "PowerShell", MOVED, false).taskId, TASK);
  assert.equal(W.armShell(TU, "Bash", BG, true), null);
  assert.equal(W.armShell(TU, "Bash", "total 4\nfile.txt", false), null);
  const w = W.armShell(TU, "Bash", BG, false);
  assert.equal(W.monitorClock(w, Number.MAX_SAFE_INTEGER), false); // no deadline
});

test("a background Bash is armed on its result and ends when it leaves tasks_live", () => {
  const t = setup();
  t.feed(live(TASK));
  t.run.onToolDone(TU, BG, false);
  assert.equal(t.state(), "armed");
  assert.equal(t.title(), "Bash · Running");
  assert.equal(t.seg().dataset.monitor, "armed"); // the chain segment spins too
  t.feed(live());
  assert.equal(t.state(), "ended");
  assert.equal(t.title(), "Bash · Ended");
  t.feed(notified("failed")); // the notification that follows names the outcome
  assert.equal(t.title(), "Bash · Failed");
  assert.equal(t.seg().dataset.monitor, "ended");
});

test("a task_notification ends it with its status", () => {
  const t = setup();
  t.run.onToolDone(TU, BG, false);
  t.feed(live(TASK));
  assert.equal(t.state(), "armed");
  t.feed(notified("completed"));
  assert.equal(t.state(), "ended");
  assert.equal(t.title(), "Bash · Completed");
});

test("a killed shell ends on its terminal task_updated", () => {
  const t = setup();
  t.run.onToolDone(TU, BG, false);
  t.feed(updated("killed"));
  assert.equal(t.state(), "ended");
  assert.equal(t.title(), "Bash · Killed");
});

test("the session ending ends it; history replay never arms", () => {
  const t = setup();
  t.run.onToolDone(TU, BG, false);
  t.run.endAll();
  assert.equal(t.title(), "Bash · Session Ended");
  const r = setup();
  r.S.replaying = true;
  r.run.onToolDone(TU, BG, false);
  assert.equal(r.state(), undefined);
});

test("a subagent's background shell is armed under its Agent pill, not on the main chain", () => {
  const t = setup(true);
  t.run.onToolDone(TU, BG, false);
  assert.equal(t.state(), "armed");
  assert.equal(t.seg(), null);
  assert.equal(t.g.label.querySelector(".chain-seg[data-monitor]"), null);
});
