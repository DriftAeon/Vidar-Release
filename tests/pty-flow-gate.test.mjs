import test from "node:test";
import assert from "node:assert/strict";

const { createFlowGate, FLOW_HIGH, FLOW_LOW } = await import("../src/panels/sessions/flow-gate.ts");

function gate(high = 100, low = 20) {
  const edges = [];
  return { g: createFlowGate(high, low, (p) => edges.push(p)), edges };
}

test("pauses once at high water, not per chunk", () => {
  const { g, edges } = gate();
  g.add(60);
  assert.deepEqual(edges, []);
  g.add(40);
  g.add(500);
  assert.deepEqual(edges, [true]);
  assert.equal(g.paused, true);
  assert.equal(g.inFlight, 600);
});

test("resumes only at low water: the gap stops per-chunk toggling", () => {
  const { g, edges } = gate();
  g.add(150);
  g.done(100); // 50 left: below high, above low, still paused
  assert.deepEqual(edges, [true]);
  g.done(30); // 20 = low
  assert.deepEqual(edges, [true, false]);
  g.add(50); // 70 < high: no new pause
  assert.deepEqual(edges, [true, false]);
});

test("over-acknowledging never goes negative or re-fires", () => {
  const { g, edges } = gate();
  g.done(10);
  assert.equal(g.inFlight, 0);
  g.add(100);
  g.done(1000);
  g.done(1000);
  assert.deepEqual(edges, [true, false]);
  assert.equal(g.inFlight, 0);
});

test("a hidden window never pauses: suspend resumes, unsuspend re-checks", () => {
  const { g, edges } = gate();
  g.add(150);
  assert.deepEqual(edges, [true]);
  g.setSuspended(true); // window hidden while paused: resume at once
  assert.deepEqual(edges, [true, false]);
  g.add(10_000); // far over high water, still no pause while hidden
  assert.deepEqual(edges, [true, false]);
  assert.equal(g.paused, false);
  g.setSuspended(false); // shown again with a backlog: pause
  assert.deepEqual(edges, [true, false, true]);
  g.done(10_150);
  assert.deepEqual(edges, [true, false, true, false]);
});

test("a gate born hidden starts suspended", () => {
  const edges = [];
  const g = createFlowGate(100, 20, (p) => edges.push(p), true);
  g.add(500);
  assert.deepEqual(edges, []);
  g.setSuspended(false);
  assert.deepEqual(edges, [true]);
});

test("a Rust-side resume (input, ceiling) lets the gate pause again at high water", () => {
  const { g, edges } = gate();
  g.add(150);
  assert.deepEqual(edges, [true]);
  g.resumed(); // Ctrl+C mid-flood: Rust unpaused the reader and said so
  assert.equal(g.paused, false);
  assert.deepEqual(edges, [true], "no echo: the reader already runs");
  g.add(10); // still over high water: backpressure comes back on
  assert.deepEqual(edges, [true, true]);
  assert.equal(g.paused, true);
  g.done(160); // low water resumes as usual
  assert.deepEqual(edges, [true, true, false]);
  g.resumed(); // a stray resume while unpaused changes nothing
  g.add(50);
  assert.deepEqual(edges, [true, true, false]);
});

test("the shipped watermarks leave xterm far below its 50 MB discard", () => {
  assert.ok(FLOW_LOW < FLOW_HIGH);
  assert.ok(FLOW_HIGH <= 4 * 1024 * 1024);
});
