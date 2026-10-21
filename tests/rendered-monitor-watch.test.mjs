// Armed/ended decision of a Monitor pill (src/panels/rendered/monitor-watch.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

const W = await import("../src/panels/rendered/monitor-watch.ts");
const START = "Monitor started (task bx7k2m9q, timeout 300000ms). You will be notified.";
const arm = (input = {}, now = 1000) => W.armMonitor("tu1", input, START, false, now);

test("a start result arms; an error or other text does not", () => {
  const w = arm();
  assert.equal(w.taskId, "bx7k2m9q");
  assert.equal(w.ended, false);
  assert.equal(W.armMonitor("tu1", {}, START, true, 0), null);
  assert.equal(W.armMonitor("tu1", {}, "something else", false, 0), null);
});

test("deadline: default 5 min, cap 1 h, plus 30 s", () => {
  assert.equal(W.monitorDeadline({}, 0), 330_000);
  assert.equal(W.monitorDeadline({ timeout_ms: 60_000 }, 0), 90_000);
  assert.equal(W.monitorDeadline({ timeout_ms: 99_999_999 }, 0), 3_630_000);
  assert.equal(W.monitorDeadline({ timeout_ms: -5 }, 0), 330_000);
  assert.equal(W.monitorDeadline(null, 0), 330_000);
});

test("done event matching the tool_use_id or the task id ends it, any status", () => {
  const a = arm();
  assert.equal(W.monitorTaskDone(a, { taskId: "zzz", toolUseId: "tu1", status: "killed" }), true);
  assert.equal(a.status, "killed");
  const b = arm();
  assert.equal(W.monitorTaskDone(b, { taskId: "bx7k2m9q" }), true);
  assert.equal(b.status, "completed");
  assert.equal(W.monitorTaskDone(b, { taskId: "bx7k2m9q" }), false); // already ended
});

test("an unrelated task leaves it armed", () => {
  const w = arm();
  assert.equal(W.monitorTaskDone(w, { taskId: "other", toolUseId: "tu9", status: "completed" }), false);
  assert.equal(w.ended, false);
});

test("tasks_live: absence ends it only after it was listed once", () => {
  const w = arm();
  assert.equal(W.monitorTasksLive(w, ["other"]), false);
  assert.equal(W.monitorTasksLive(w, ["bx7k2m9q"]), false);
  assert.equal(W.monitorTasksLive(w, []), true);
  assert.equal(w.status, "gone");
});

test("the deadline and the session end both end it", () => {
  const w = arm({}, 0);
  assert.equal(W.monitorClock(w, 329_999), false);
  assert.equal(W.monitorClock(w, 330_000), true);
  assert.equal(w.status, "timeout");
  const s = arm();
  assert.equal(W.monitorSessionEnd(s), true);
  assert.equal(W.monitorSessionEnd(s), false);
});

test("titles", () => {
  const w = arm();
  assert.equal(W.monitorTitle(w), "Monitor · watching");
  W.monitorTaskDone(w, { taskId: "bx7k2m9q", status: "completed" });
  assert.equal(W.monitorTitle(w), "Monitor · ended (completed)");
});
