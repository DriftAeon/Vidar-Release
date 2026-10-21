import test from "node:test";
import assert from "node:assert/strict";

const { createPtyResize, RESIZE_SETTLE_MS } = await import("../src/panels/sessions/pty-resize.ts");

// Fake timers: setTimeout/clearTimeout over a table, fired by hand.
function fakeTimers() {
  let next = 1;
  const live = new Map();
  return {
    set: (fn, ms) => { const h = next++; live.set(h, { fn, ms }); return h; },
    clear: (h) => { live.delete(h); },
    fireAll: () => { for (const [h, t] of [...live]) { live.delete(h); t.fn(); } },
    count: () => live.size,
  };
}

function rig() {
  const sent = [];
  const t = fakeTimers();
  const r = createPtyResize((id) => sent.push(id), { setTimeout: t.set, clearTimeout: t.clear }, RESIZE_SETTLE_MS);
  return { r, sent, t };
}

test("several later calls for one id fire one trailing send", () => {
  const { r, sent, t } = rig();
  r.later("a");
  r.later("a");
  r.later("a");
  assert.equal(t.count(), 1);
  t.fireAll();
  assert.deepEqual(sent, ["a"]);
});

test("cancel after later sends nothing", () => {
  const { r, sent, t } = rig();
  r.later("a");
  r.cancel("a");
  t.fireAll();
  assert.deepEqual(sent, []);
});

test("now cancels the pending timer and sends at once", () => {
  const { r, sent, t } = rig();
  r.later("a");
  r.now("a");
  assert.deepEqual(sent, ["a"]);
  t.fireAll();
  assert.deepEqual(sent, ["a"]);
});

test("ids settle independently", () => {
  const { r, sent, t } = rig();
  r.later("a");
  r.later("b");
  r.cancel("a");
  t.fireAll();
  assert.deepEqual(sent, ["b"]);
});
