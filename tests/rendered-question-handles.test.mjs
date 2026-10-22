// cards.ts openQuestions(): each pending question card is a record plus an answer settled through the
// card's own path. A handle answers once; a second answer is refused; a card out of the document yields none.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createCards } = await import("../src/panels/rendered/cards.ts");

function harness() {
  const S = { hydrating: false, stick: false, pendingApproval: null, adapter: { encodePermission: (id, d) => JSON.stringify({ id, d }) } };
  const sent = [];
  const approvals = new Map();
  const deps = {
    transport: { durable: false },
    textarea: document.createElement("textarea"),
    follow: { toBottom() {}, jump() {}, programmatic: () => false, dispose() {} },
    tools: new Map(), approvals,
    approvalQueue: [],
    awaiting: new Map(),
    sendEncoded: async (line) => { sent.push(JSON.parse(line)); return true; },
    append: (n) => document.body.appendChild(n),
    sealGroup() {}, groupRefresh() {}, stalePill() {},
    refreshState() {},
    noticeBlock() {},
    agent: "claude",
  };
  return { sent, approvals, cards: createCards(S, deps) };
}

const INPUT = { questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }] };

test("a handle's answer settles the card once with the reply as updatedInput", async () => {
  const h = harness();
  h.cards.approvalCard("q1", undefined, "AskUserQuestion", INPUT, 10, []);
  const [handle] = h.cards.openQuestions();
  assert.equal(handle.key, "q1");
  assert.equal(handle.record.questions[0].text, "Which one?");
  await handle.answer({ answers: { "0:Which one?": "B" }, notes: "" });
  assert.equal(h.approvals.has("q1"), false);
  assert.deepEqual(h.sent, [{ id: "q1", d: { behavior: "allow", updatedInput: { questions: INPUT.questions, answers: { "Which one?": "B" } } } }]);
  assert.equal(h.cards.openQuestions().length, 0);
});

test("a second answer throws Already Answered and sends nothing", async () => {
  const h = harness();
  h.cards.approvalCard("q2", undefined, "AskUserQuestion", INPUT, 10, []);
  const [handle] = h.cards.openQuestions();
  await handle.answer({ answers: { "0:Which one?": "A" }, notes: "" });
  await assert.rejects(handle.answer({ answers: { "0:Which one?": "B" }, notes: "" }), /Already Answered/);
  assert.equal(h.sent.length, 1);
});

test("a card out of the document yields no handle", () => {
  const h = harness();
  h.cards.approvalCard("q3", undefined, "AskUserQuestion", INPUT, 10, []);
  assert.equal(h.cards.openQuestions().length, 1);
  h.approvals.get("q3").remove();
  assert.equal(h.cards.openQuestions().length, 0);
});
