import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { describeStamp, renderRelease } from "../src/settings/release-view.ts";

const head = "abcdef0" + "1".repeat(33);
const stamp = (over = {}) => ({ head, dirty: false, builtUtc: "2026-10-11T00:00:00Z", local: true, ...over });
const doc = () => new JSDOM("<!doctype html><body></body>").window.document;

test("a stamp shows the short commit, with the full hash and build time in the tooltip", () => {
  const { label, tip } = describeStamp(stamp());
  assert.equal(label, head.slice(0, 7));
  assert.ok(tip.includes(head));
  assert.ok(tip.includes("2026-10-11T00:00:00Z"));
});

test("dirty shows Local Changes only for a local build, never for a release zip", () => {
  assert.match(describeStamp(stamp({ dirty: true })).label, /Local Changes/);
  assert.doesNotMatch(describeStamp(stamp({ dirty: true, local: false })).label, /Local Changes/);
  assert.doesNotMatch(describeStamp(stamp({ dirty: false })).label, /Local Changes/);
});

test("a missing stamp shows Dev Build with no commit", () => {
  const root = renderRelease(doc(), null, async () => {});
  const text = root.textContent ?? "";
  assert.ok(text.includes("Dev Build"));
  assert.doesNotMatch(text, /[0-9a-f]{7}/);
});

test("the row has one action that opens releases and reports a failure to open", async () => {
  let opened = 0;
  const failing = renderRelease(doc(), stamp(), async () => { opened++; throw new Error("no"); });
  const buttons = failing.querySelectorAll("button");
  assert.equal(buttons.length, 1);
  buttons[0].click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(opened, 1);
  assert.ok(failing.querySelector("[role=status]").textContent.length > 0);
});
