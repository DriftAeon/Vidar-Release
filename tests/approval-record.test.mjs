// The approval registry (src/asks/approvals.ts): one settle per record, whichever of answer, expiry or
// cancel gets there first; slices replace; the busy refusal text is the one the retired modal used.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { APPROVAL_TITLES } = await import("../src/asks/approval.ts");
const reg = await import("../src/asks/approvals.ts");
const store = await import("../src/relay/store.ts");
const { startApprovalSource } = await import("../src/relay/source-approvals.ts");

function rec(id, over = {}) {
  return {
    id, origin: "ctl-prompt", title: APPROVAL_TITLES["ctl-prompt"],
    asker: { tab: "t1", label: "Tab 1", verified: true },
    rows: [["Tab", "t1"]], askedAtMs: Date.now(), comment: true, drawInAskerTab: true, ...over,
  };
}
const ok = { verdict: "approve", comment: "", where: "Relay" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("first answer wins across two answerers", async () => {
  const outcomes = [];
  assert.equal(reg.openApproval(rec("a1"), (o) => outcomes.push(o)), null);
  const [a, b] = [reg.liveApprovals()[0], reg.liveApprovals()[0]];
  await a.answer({ ...ok, where: "Tab" });
  await assert.rejects(b.answer(ok), /Already Answered/);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].where, "Tab");
  assert.equal(reg.liveApprovals().length, 0);
});

test("expiry settles once and a later answer throws Already Answered", async () => {
  const outcomes = [];
  reg.openApproval(rec("e1", { expiresAtMs: Date.now() + 20 }), (o) => outcomes.push(o));
  const entry = reg.liveApprovals()[0];
  await wait(80);
  assert.deepEqual(outcomes, [{ verdict: "expired", reason: "expired" }]);
  await assert.rejects(entry.answer(ok), /Already Answered/);
  assert.equal(reg.cancelApproval("e1", "late"), false);
  assert.equal(outcomes.length, 1);
});

test("cancelApproval settles cancelled once", async () => {
  const outcomes = [];
  reg.openApproval(rec("c1", { expiresAtMs: Date.now() + 5000 }), (o) => outcomes.push(o));
  assert.equal(reg.cancelApproval("c1", "gone"), true);
  assert.equal(reg.cancelApproval("c1", "gone"), false);
  assert.deepEqual(outcomes, [{ verdict: "cancelled", reason: "gone" }]);
  assert.equal(reg.liveApprovals().length, 0);
});

test("slice replace drops records and Relay follows", () => {
  startApprovalSource();
  const entry = (id) => ({ record: rec(id, { origin: "flow", title: "Tool Approval" }), answer: async () => {} });
  reg.setApprovalSlice("flow", [entry("f1"), entry("f2")]);
  assert.equal(reg.liveApprovals().length, 2);
  assert.equal(store.items().filter((i) => i.source === "approvals").length, 2);
  reg.setApprovalSlice("flow", [entry("f2")]);
  assert.deepEqual(reg.liveApprovals().map((e) => e.record.id), ["f2"]);
  assert.deepEqual(store.items().filter((i) => i.source === "approvals").map((i) => i.id), ["f2"]);
  reg.setApprovalSlice("flow", []);
  assert.equal(reg.liveApprovals().length, 0);
});

test("a throwing subscriber still settles once", async () => {
  const bad = reg.subscribeApprovals(() => { throw new Error("boom"); });
  const origErr = console.error;
  console.error = () => {};
  try {
    const outcomes = [];
    assert.equal(reg.openApproval(rec("t1x", { expiresAtMs: Date.now() + 5000 }), (o) => outcomes.push(o)), null);
    await reg.liveApprovals()[0].answer(ok);
    assert.equal(outcomes.length, 1);
    assert.equal(reg.liveApprovals().length, 0);
  } finally {
    console.error = origErr;
    bad();
  }
});

test("a duplicate id is refused while live", () => {
  assert.equal(reg.openApproval(rec("d1", { expiresAtMs: Date.now() + 5000 }), () => {}), null);
  assert.equal(
    reg.openApproval(rec("d1", { asker: { tab: "t5", label: "T5", verified: true }, expiresAtMs: Date.now() + 5000 }), () => {}),
    'an approval with id "d1" is already open',
  );
  reg.cancelApproval("d1", "done");
});

test("card comment reaches resolve trimmed and the textarea locks while sending", async () => {
  const { createCardForm } = await import("../src/relay/card-view.ts");
  const got = [];
  const item = { view: { type: "card", rows: [["Tab", "t1"]], comment: true }, resolve: async (a) => { got.push(a); } };
  const host = document.createElement("div");
  createCardForm(host, item);
  const ta = host.querySelector("textarea");
  assert.equal(ta.placeholder, "Additional Info");
  ta.value = "  hello \n";
  host.querySelector(".relay-approve").click();
  assert.equal(ta.disabled, true);
  await wait(5);
  assert.deepEqual(got, [{ verdict: "approve", comment: "hello" }]);
});

test("busy refusal text is byte-identical; astra is global", async () => {
  assert.equal(reg.openApproval(rec("b1"), () => {}), null);
  assert.equal(
    reg.openApproval(rec("b2"), () => {}),
    'an ask for "ctl-prompt" is already on screen or queued; only one at a time is useful',
  );
  assert.equal(reg.openApproval(rec("b3", { asker: { tab: "t2", label: "Tab 2", verified: true } }), () => {}), null);
  assert.equal(reg.openApproval(rec("s1", { origin: "astra" }), () => {}), null);
  assert.match(reg.openApproval(rec("s2", { origin: "astra", asker: { tab: "t9", label: "x", verified: false } }), () => {}), /"astra"/);
  for (const id of ["b1", "b3", "s1"]) reg.cancelApproval(id, "done");
});
