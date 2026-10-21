// Regression (inbox 2026-10-02 flow-timer-frozen): an unfinished span must keep counting on its own
// clock between node events, and a finished one must stop.
import test from "node:test";
import assert from "node:assert/strict";
import { elapsedLabel, markLive, tickLive, totalLabel } from "../src/flow/run-clock.ts";

const T0 = "2026-10-02T10:00:00.000Z";
const t0 = Date.parse(T0);

test("elapsedLabel: an unfinished span runs to now, a finished one is fixed", () => {
  assert.equal(elapsedLabel(T0, undefined, t0 + 100), "0.1s");
  assert.equal(elapsedLabel(T0, undefined, t0 + 12_340), "12.3s");
  assert.equal(elapsedLabel(T0, "2026-10-02T10:00:05.000Z", t0 + 99_000), "5.0s");
  assert.equal(elapsedLabel(undefined, undefined, t0), undefined);
  assert.equal(elapsedLabel(T0, undefined, t0 - 1), undefined);
});

test("totalLabel: spans the run, not a node; a running run reads live", () => {
  assert.equal(totalLabel({ startedAt: T0, endedAt: "2026-10-02T10:00:30.000Z" }), "30.0s Total");
  assert.match(totalLabel({ startedAt: new Date(Date.now() - 5_000).toISOString() }), /^[45]\.\ds Total$/);
  assert.equal(totalLabel(undefined), undefined);
});

test("tickLive: rewrites a live element as time passes, leaves an ended one alone", () => {
  const mk = () => ({ dataset: {}, textContent: "0.1s" });
  const live = mk();
  const ended = mk();
  markLive(live, T0, undefined, " Total");
  markLive(ended, T0, "2026-10-02T10:00:01.000Z");
  const root = { querySelectorAll: () => [live, ended].filter((e) => e.dataset.liveStart) };
  assert.equal(tickLive(root, t0 + 4_000), 1);
  assert.equal(live.textContent, "4.0s Total");
  tickLive(root, t0 + 9_000);
  assert.equal(live.textContent, "9.0s Total");
  assert.equal(ended.textContent, "0.1s");
});
