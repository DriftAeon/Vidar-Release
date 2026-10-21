// The launcher body column's order (launcher/body-order.ts): a pure function of the shown Rendered
// row, the shown Bare rows and the lead.
import test from "node:test";
import assert from "node:assert/strict";
import { bodyOrder, readLead, DEFAULT_LEAD } from "../src/launcher/body-order.ts";

const cb = { key: "claude-bare", label: "Bare" };
const crb = { key: "claude-rendered-bare", label: "Rendered Bare" };
const names = (rows) => rows.map((r) => (r.kind === "bare" ? r.variant.key : r.kind));

test("raw lead keeps Raw, Rendered, Bare, Rendered Bare", () => {
  assert.deepEqual(names(bodyOrder(true, [cb, crb], "raw")), ["raw", "rendered", "claude-bare", "claude-rendered-bare"]);
});

test("bare lead puts the preferred Bare variant first", () => {
  assert.deepEqual(names(bodyOrder(true, [cb, crb], "bare")), ["claude-rendered-bare", "raw", "rendered", "claude-bare"]);
});

test("hidden preferred variant falls back to the next shown Bare", () => {
  assert.deepEqual(names(bodyOrder(true, [cb], "bare")), ["claude-bare", "raw", "rendered"]);
});

test("no shown Bare keeps Raw first", () => {
  assert.deepEqual(names(bodyOrder(true, [], "bare")), ["raw", "rendered"]);
  assert.deepEqual(names(bodyOrder(false, [], "bare")), ["raw"]);
});

test("an unreadable lead reads as the build default", () => {
  assert.equal(DEFAULT_LEAD, "bare");
  assert.equal(readLead("bare"), "bare");
  assert.equal(readLead("raw"), "raw");
  for (const v of [undefined, null, "Bare", "", 1, {}]) assert.equal(readLead(v), DEFAULT_LEAD);
});
