// Relay pending-ask contract (src/relay/source-asks.ts, store.ts): the delivered text comes from the
// re-read entry and never echoes the question, a changed sha refuses delivery, and ask items stay
// unread on a source's first snapshot.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    "panels/sessions": `export const findTabByFalconSessionHosted = async () => "tab-1";
      export const sessionTitle = () => "Tab One";
      export const renderedBody = () => ({ alive: () => true, promptReady: () => true });`,
    "control/registry": `export const sendPromptTo = async (tab, text) => { if (globalThis.__failSend) throw new Error("send failed"); (globalThis.__sent ??= []).push({ tab, text }); };`,
  },
});
const { refresh, sendAnswer, answerText } = await import("../src/relay/source-asks.ts");
const store = await import("../src/relay/store.ts");

const ASK = {
  id: "0123456789abcdef", session: "s1", question: "Which database should we pick?",
  choices: ["sqlite", "postgres"], askedAtMs: 1000, sha256: "aaa",
};
const calls = [];
let served = ASK;
Object.assign(dom.ipc.answers, {
  list_pending_asks: () => ({ items: [served] }),
  claim_pending_ask: (a) => { calls.push(["claim", a]); },
  release_pending_ask: (a) => { calls.push(["release", a]); },
  settle_pending_ask: (a) => { calls.push(["settle", a]); },
});

test("relay ask: ask items stay unread on the first snapshot", async () => {
  await refresh();
  assert.ok(store.items().some((i) => i.id === ASK.id));
  assert.equal(store.isUnread(ASK.id), true, "a restart-time ask was auto-seen");
});

test("relay ask: a pend entry is a question item carrying the record, the entry and the asker tab", () => {
  const it = store.items().find((i) => i.id === ASK.id);
  assert.equal(it.kind, "question");
  assert.equal(it.view.type, "question");
  assert.equal(it.view.pend.sha256, "aaa");
  assert.equal(it.view.record.origin, "pend");
  assert.equal(it.view.record.needsPrompt, true);
  assert.deepEqual(it.view.record.questions[0].options.map((o) => o.label), ["sqlite", "postgres"]);
  assert.equal(it.askerTab, "tab-1");
});

test("relay ask: resolve with a reply sends the pend wire text", async () => {
  globalThis.__sent = [];
  calls.length = 0;
  served = ASK;
  await store.items().find((i) => i.id === ASK.id).resolve({ verdict: "approve", comment: "needs json", reply: { answers: { "0:Which database should we pick?": "postgres" }, notes: "needs json" } });
  assert.equal(globalThis.__sent[0].text, 'Answer to pending question 01234567: choice="postgres" comment="needs json"');
});

test("relay ask: a refused claim reads Already Answered, a changed entry Question Changed", async () => {
  const ok = dom.ipc.answers.claim_pending_ask;
  try {
    dom.ipc.answers.claim_pending_ask = () => { throw new Error("pending ask already being answered"); };
    await assert.rejects(sendAnswer(ASK, "sqlite", ""), /^Error: Already Answered$/);
    dom.ipc.answers.claim_pending_ask = () => { throw new Error("pending ask not found"); };
    await assert.rejects(sendAnswer(ASK, "sqlite", ""), /^Error: Already Answered$/);
    dom.ipc.answers.claim_pending_ask = () => { throw new Error("pending ask changed"); };
    await assert.rejects(sendAnswer(ASK, "sqlite", ""), /^Error: Question Changed$/);
  } finally {
    dom.ipc.answers.claim_pending_ask = ok;
  }
});

test("relay ask: Dismiss waits out a send in flight", async () => {
  served = ASK;
  let release;
  const prev = globalThis.__failSend;
  dom.ipc.answers.claim_pending_ask = () => new Promise((r) => { release = r; });
  const it = store.items().find((i) => i.id === ASK.id);
  const sending = sendAnswer(ASK, "sqlite", "");
  await assert.rejects(it.resolve({ verdict: "deny", comment: "" }), /Already Sending/);
  release();
  await sending;
  dom.ipc.answers.claim_pending_ask = (a) => { calls.push(["claim", a]); };
  globalThis.__failSend = prev;
});

test("relay ask: the answer text is built from the re-read entry and never contains the question", async () => {
  globalThis.__sent = [];
  calls.length = 0;
  await sendAnswer(ASK, "postgres", "needs json");
  assert.deepEqual(globalThis.__sent, [{ tab: "tab-1", text: answerText(ASK, "postgres", "needs json") }]);
  const text = globalThis.__sent[0].text;
  assert.equal(text, 'Answer to pending question 01234567: choice="postgres" comment="needs json"');
  assert.ok(!text.includes("database"), "the question was echoed");
  assert.deepEqual(calls.map((c) => c[0]), ["claim", "settle"]);
});

test("relay ask: a changed sha refuses delivery and releases the claim", async () => {
  globalThis.__sent = [];
  calls.length = 0;
  served = { ...ASK, sha256: "bbb" };
  await assert.rejects(sendAnswer(ASK, "sqlite", ""), /Question Changed/);
  assert.equal(globalThis.__sent.length, 0, "an answer was delivered against a changed question");
  assert.deepEqual(calls.map((c) => c[0]), ["claim", "release"]);
});

test("relay ask: a settle failure after delivery keeps the claim and shows the note", async () => {
  globalThis.__sent = [];
  calls.length = 0;
  served = ASK;
  const ok = dom.ipc.answers.settle_pending_ask;
  dom.ipc.answers.settle_pending_ask = () => { throw new Error("disk"); };
  try {
    await assert.rejects(sendAnswer(ASK, "sqlite", ""), /^Error: Sent; Could Not Clear the Ask$/);
  } finally {
    dom.ipc.answers.settle_pending_ask = ok;
  }
  assert.equal(globalThis.__sent.length, 1);
  assert.ok(!calls.some((c) => c[0] === "release"), "the claim was released after delivery");
});

test("relay ask: a send failure releases the claim", async () => {
  calls.length = 0;
  served = ASK;
  globalThis.__failSend = true;
  try {
    await assert.rejects(sendAnswer(ASK, "sqlite", ""), /send failed/);
  } finally { globalThis.__failSend = false; }
  assert.deepEqual(calls.map((c) => c[0]), ["claim", "release"]);
});

test("relay ask: the transcript's parser reads back every answer text the source builds", async () => {
  const { parseRelayAnswer } = await import("../src/panels/rendered/relay-answer.ts");
  const cases = [["postgres", "needs json"], [null, 'why "global"?\nsecond line'], ["Neither for now", ""]];
  for (const [choice, comment] of cases) {
    assert.deepEqual(parseRelayAnswer(answerText(ASK, choice, comment)), { choice, comment: comment || null });
  }
  assert.equal(parseRelayAnswer("Answer to pending question 01234567: choice=1 comment=null"), null);
});
