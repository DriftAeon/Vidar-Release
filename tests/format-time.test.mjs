// Time helpers in src/format.ts: clock, mmss, agoSecs, agoSince.
import test from "node:test";
import assert from "node:assert/strict";
import { clock, mmss, agoSecs, agoSince } from "../src/format.ts";

test("clock: local HH:MM, zero padded", () => {
  assert.equal(clock(new Date(2026, 0, 2, 3, 4).getTime()), "03:04");
  assert.equal(clock(new Date(2026, 0, 2, 23, 59).getTime()), "23:59");
});

test("mmss: mm:ss, h:mm:ss past an hour, clamped at zero", () => {
  assert.equal(mmss(0), "00:00");
  assert.equal(mmss(65_000), "01:05");
  assert.equal(mmss(3_661_000), "1:01:01");
  assert.equal(mmss(-5), "00:00");
});

test("agoSecs: seconds, minutes, hours", () => {
  assert.equal(agoSecs(42), "42s ago");
  assert.equal(agoSecs(300), "5m ago");
  assert.equal(agoSecs(3 * 3600), "3h ago");
});

test("agoSince: just now under a minute, then minutes, hours, local date", () => {
  const now = Date.now();
  assert.equal(agoSince(now - 10_000), "just now");
  assert.equal(agoSince(now - 5 * 60_000), "5m ago");
  assert.equal(agoSince(now - 3 * 3_600_000), "3h ago");
  const old = now - 3 * 86_400_000;
  assert.equal(agoSince(old), new Date(old).toLocaleDateString());
});
