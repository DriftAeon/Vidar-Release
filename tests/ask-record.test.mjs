// Ask record contract (src/asks/record.ts): the reply mapper equals what questionForm.collect() builds
// for the same picks (Claude keyed by text, Codex by id), a pend reply's wire text parses back, and
// identical question texts keep distinct keys.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "panels/sessions": `export const findTabByFalconSessionHosted = async () => "tab-1";
      export const sessionTitle = () => "Tab One";
      export const renderedBody = () => ({ alive: () => true, promptReady: () => true });`,
    "control/registry": `export const sendPromptTo = async () => {};`,
  },
});
const { questionForm } = await import("../src/panels/rendered/question-form.ts");
const rec = await import("../src/asks/record.ts");
const { answerText } = await import("../src/relay/source-asks.ts");
const { parseRelayAnswer } = await import("../src/panels/rendered/relay-answer.ts");

const BASE = { key: "k", origin: "claude", askedAtMs: 1 };
const click = (card, qi, label) => [...card.querySelectorAll(".q-options")[qi].querySelectorAll(".q-opt")].find((b) => b.dataset.label === label).click();
const typeOther = (card, qi, v) => {
  const o = card.querySelectorAll(".q-options")[qi].querySelector(".q-other");
  o.value = v;
  o.dispatchEvent(new window.Event("input"));
};

function sameAsCollect(input, base, pick) {
  const card = document.createElement("div");
  const form = questionForm(card, input, () => {});
  pick(card);
  const collected = form.collect();
  const record = rec.recordFromAskInput(input, base);
  const reply = { answers: {}, notes: "" };
  input.questions.forEach((q, i) => { reply.answers[record.questions[i].id] = collected.answers[q.id ?? q.question]; });
  assert.deepEqual(rec.updatedInputFromReply(input.questions, record, reply), collected);
  return record;
}

test("Claude input keyed by text: reply mapper equals collect()", () => {
  const input = { questions: [
    { question: "One?", options: [{ label: "A" }, { label: "B", description: "bee" }] },
    { question: "Many?", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
  ] };
  const record = sameAsCollect(input, BASE, (card) => {
    click(card, 0, "B");
    click(card, 1, "X");
    click(card, 1, "Y");
    typeOther(card, 1, "Z");
  });
  assert.deepEqual(record.questions.map((q) => [q.multi, q.other]), [[false, true], [true, true]]);
  assert.deepEqual(record.questions[0].options[1], { label: "B", description: "bee" });
});

test("Codex input keyed by id: reply mapper equals collect(), other follows isOther or free text", () => {
  const input = { questions: [
    { id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }] },
    { id: "q2", question: "Why?", options: [{ label: "C" }], isOther: true },
    { id: "q3", question: "Name?" },
  ] };
  const record = sameAsCollect(input, { ...BASE, origin: "codex" }, (card) => {
    click(card, 0, "A");
    typeOther(card, 1, "mine");
    typeOther(card, 2, "Ada");
  });
  assert.deepEqual(record.questions.map((q) => [q.id, q.other]), [["q1", false], ["q2", true], ["q3", true]]);
});

test("identical texts get distinct keys", () => {
  const input = { questions: [{ question: "Same?", options: [{ label: "A" }] }, { question: "Same?", options: [{ label: "A" }] }] };
  const [a, b] = rec.recordFromAskInput(input, BASE).questions;
  assert.notEqual(a.id, b.id);
});

test("pend reply: wire text parses back; notes win over Other", () => {
  const record = rec.recordFromAskInput({ questions: [{ question: "Db?", options: [{ label: "sqlite" }, { label: "postgres" }] }] }, { ...BASE, origin: "pend" });
  assert.equal(record.notes, true);
  const id = record.questions[0].id;
  const pick = rec.pendReplyParts(record, { answers: { [id]: "postgres" }, notes: " fast " });
  assert.deepEqual(pick, { choice: "postgres", comment: "fast" });
  assert.deepEqual(parseRelayAnswer(answerText({ id: "0123456789abcdef" }, pick.choice, pick.comment)), { choice: "postgres", comment: "fast" });
  const other = rec.pendReplyParts(record, { answers: { [id]: "mysql" }, notes: "" });
  assert.deepEqual(other, { choice: null, comment: "mysql" });
  assert.deepEqual(parseRelayAnswer(answerText({ id: "0123456789abcdef" }, other.choice, other.comment)), { choice: null, comment: "mysql" });
});

test("ctl-ask reply lines match listen.ts", () => {
  const record = rec.recordFromAskInput({ questions: [{ question: "Go?", options: [{ label: "yes" }] }] }, { ...BASE, origin: "ctl-ask" });
  const id = record.questions[0].id;
  assert.equal(rec.ctlAskReplyLine(record, { answers: { [id]: "yes" }, notes: "now" }), 'answered choice=yes comment="now"');
  assert.equal(rec.ctlAskReplyLine(record, { answers: { [id]: "" }, notes: "" }), 'answered choice=- comment=""');
  assert.equal(rec.ctlAskDeniedLine("no"), "denied no");
});
