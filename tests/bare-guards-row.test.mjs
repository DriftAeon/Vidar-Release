import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { guardsControl, guardsValue } from "../src/settings/bare-guards.ts";

const doc = () => new JSDOM("<!doctype html><body></body>").window.document;
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the guard value reads None, then a count", () => {
  assert.equal(guardsValue(0), "None");
  assert.equal(guardsValue(1), "1 Guard");
  assert.equal(guardsValue(2), "2 Guards");
});

test("the Guards row is dim text when none and a plain count when listed", async () => {
  const d = doc();
  const none = guardsControl(d, async () => 0);
  await tick();
  assert.equal(none.className, "ag-readonly");
  assert.equal(none.textContent, "None");
  assert.equal(none.querySelector("b"), null);
  const two = guardsControl(d, async () => 2);
  await tick();
  assert.equal(two.querySelector("b").textContent, "2 Guards");
});

test("a failed read leaves the value blank", async () => {
  const blank = guardsControl(doc(), async () => { throw new Error("boom"); });
  await tick();
  assert.equal(blank.textContent, "");
});
