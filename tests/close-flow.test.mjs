import test from "node:test";
import assert from "node:assert/strict";

const { closeInBackground } = await import("../src/panels/sessions/close-flow.ts");
const { createCloseNotices, closeNoticeTitle } = await import("../src/panels/sessions/close-notice.ts");

function harness(body, kind = "hosted") {
  const log = [];
  let finalized = 0;
  const deps = {
    kind, label: "Claude 1", body,
    classify: (e) => (String(e).includes("falcon control disconnected") ? "remove" : "keep"),
    removeView: () => log.push("remove"),
    finalize: () => { finalized++; log.push("finalize"); },
    fail: (label, msg) => log.push(`fail:${label}:${msg}`),
  };
  return { deps, log, finalized: () => finalized };
}
const body = (over = {}) => ({
  shutdown: async () => {}, detach: async () => {}, abandon: async () => {}, disconnected: () => false, ...over,
});
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

test("the view leaves before shutdown settles; the body is finalized only after the ack, once, no notice", async () => {
  const d = deferred();
  const h = harness(body({ shutdown: () => d.p }));
  const run = closeInBackground(h.deps);
  await Promise.resolve();
  assert.deepEqual(h.log, ["remove"]); // spawn / active turn: body stays alive, not finalized
  d.resolve();
  await run;
  assert.deepEqual(h.log, ["remove", "finalize"]);
  assert.equal(h.finalized(), 1);
});

test("a keep-class rejection finalizes once and raises a notice", async () => {
  const abandon = [];
  const h = harness(body({ shutdown: async () => { throw "falcon did not answer close within 40s"; }, abandon: async () => { abandon.push(1); } }));
  await closeInBackground(h.deps);
  assert.equal(h.finalized(), 1);
  assert.equal(abandon.length, 1);
  assert.deepEqual(h.log.slice(0, 1), ["remove"]);
  assert.match(h.log[1], /^fail:Claude 1:falcon did not answer/);
});

test("an unreachable host abandons and notifies instead of staying silent", async () => {
  let abandoned = 0;
  const h = harness(body({ shutdown: async () => { throw "falcon control disconnected"; }, abandon: async () => { abandoned++; } }));
  await closeInBackground(h.deps);
  assert.equal(abandoned, 1);
  assert.match(h.log.find((l) => l.startsWith("fail")), /Falcon unreachable/);
  assert.equal(h.finalized(), 1);

  const g = harness(body({ disconnected: () => true, shutdown: async () => { throw new Error("must not wait"); } }));
  await closeInBackground(g.deps);
  assert.match(g.log.find((l) => l.startsWith("fail")), /Falcon unreachable/);
  assert.equal(g.finalized(), 1);
});

test("local close: detach rejection still finalizes once and notifies; success is silent", async () => {
  const ok = harness(body(), "local");
  await closeInBackground(ok.deps);
  assert.deepEqual(ok.log, ["remove", "finalize"]);
  const bad = harness(body({ detach: async () => { throw new Error("stop failed"); } }), "local");
  await closeInBackground(bad.deps);
  assert.equal(bad.finalized(), 1);
  assert.match(bad.log.find((l) => l.startsWith("fail")), /stop failed/);
});

function fakeIo() {
  const io = { shown: [], hidden: 0, timers: new Map(), next: 1 };
  io.show = (f) => io.shown.push(f.map((x) => x.label));
  io.hide = () => { io.hidden++; };
  io.schedule = (fn) => { const h = io.next++; io.timers.set(h, fn); return h; };
  io.cancel = (h) => io.timers.delete(h);
  return io;
}

test("three failures aggregate into one notice with count 3; auto-hide fires the last timer", () => {
  const io = fakeIo();
  const n = createCloseNotices(io);
  n.report("A", "e"); n.report("B", "e"); n.report("C", "e");
  assert.equal(n.count(), 3);
  assert.deepEqual(io.shown.at(-1), ["A", "B", "C"]);
  assert.equal(io.timers.size, 1);
  assert.equal(closeNoticeTitle(3), "3 Sessions May Still Be Running");
  assert.equal(closeNoticeTitle(1), "1 Session May Still Be Running");
  [...io.timers.values()][0]();
  assert.equal(n.count(), 0);
  assert.equal(io.hidden, 1);
});

test("pagehide suppression drops later failures", () => {
  const io = fakeIo();
  const n = createCloseNotices(io);
  n.suppress();
  n.report("A", "e");
  assert.equal(io.shown.length, 0);
  assert.equal(n.count(), 0);
});
