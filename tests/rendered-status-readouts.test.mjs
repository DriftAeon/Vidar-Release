// 5H / 7D readouts past their reset time (cover review nit 10): the last rate-limit event's % belongs
// to the window that ended, so a passed resetsAt reads as reset until the next event.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { statusReadouts } = await import("../src/panels/rendered/status-readouts.ts");

const line = (limits) => ({ ctxPct: null, ctxTokens: 0, contextWindow: null, limits: new Map(Object.entries(limits)) });
const fills = (rd) => [...rd.querySelectorAll(".chunk-fill")].map((f) => f.style.height);

test("readouts: a window past its resetsAt shows no fill and no reset time", () => {
  const now = 1_800_000_000_000;
  const past = now / 1000 - 60;
  const rd = statusReadouts(line({ five_hour: { pct: 95, resetsAt: past }, seven_day: { pct: 95, resetsAt: past } }), now);
  const five = rd.querySelector(".sl-five"), week = rd.querySelector(".sl-week");
  assert.equal(five.querySelector(".rd-num").textContent, "0%");
  assert.ok(five.classList.contains("sl-ok") && !five.classList.contains("sl-bad"));
  assert.equal(five.title, "5-Hour Window: 0% Used");
  assert.equal(week.title, "7-Day Window: 0% Used");
  assert.ok(fills(rd).every((h) => h === "0%"), fills(rd).join(","));
});

test("readouts: a window before its resetsAt keeps its numbers", () => {
  const now = 1_800_000_000_000;
  const rd = statusReadouts(line({ five_hour: { pct: 95, resetsAt: now / 1000 + 60 } }), now);
  const five = rd.querySelector(".sl-five");
  assert.equal(five.querySelector(".rd-num").textContent, "95%");
  assert.ok(five.classList.contains("sl-bad"));
  assert.ok(five.title.startsWith("5-Hour Window: 95% Used · Resets "));
});
