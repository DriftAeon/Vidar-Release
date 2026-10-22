// A card-backed question reaches Relay (rendered/question-relay.ts): one `question` item per pending
// card, answered through the card's own settle, so the first answer wins. A chat answer leaves the slice
// and tells Relay via vidar-ask-settled; a Relay answer folds the card with an "Answered in Relay" check.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createCards } = await import("../src/panels/rendered/cards.ts");
const { createQuestionRelay } = await import("../src/panels/rendered/question-relay.ts");
const store = await import("../src/relay/store.ts");

const items = () => store.items().filter((i) => i.source === "card-questions");
const INPUT = { questions: [{ question: "Which drawer?", header: "Drawer", multiSelect: false, options: [{ label: "Left" }, { label: "Right" }] }] };

function harness(tabId = "tab-1") {
  const S = { hydrating: false, stick: false, pendingApproval: null, adapter: { encodePermission: (id, d) => JSON.stringify({ id, d }) } };
  const sent = [];
  const approvals = new Map();
  let cards;
  const relay = createQuestionRelay({ tabId, tabName: "Vidar Work", openQuestions: () => cards.openQuestions(), hydrating: () => S.hydrating });
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
    refreshState: () => relay.refresh(),
    noticeBlock() {},
    agent: "claude",
  };
  cards = createCards(S, deps);
  return { S, sent, approvals, relay, cards };
}

test("a pending question publishes one question item for its tab", () => {
  document.body.replaceChildren();
  const h = harness("t-pub");
  h.cards.approvalCard("q1", undefined, "AskUserQuestion", INPUT, 10, []);
  const list = items();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "question");
  assert.equal(list[0].askerTab, "t-pub");
  assert.equal(list[0].view.record.askerTab, "t-pub");
  assert.equal(document.querySelector(".blk-question").dataset.askKey, "q1");
  h.relay.dispose();
  assert.equal(items().length, 0);
});

test("a question answered in chat leaves the slice and dispatches vidar-ask-settled once", async () => {
  document.body.replaceChildren();
  const h = harness("t-chat");
  const events = [];
  const on = (e) => events.push(e.detail);
  window.addEventListener("vidar-ask-settled", on);
  h.cards.approvalCard("q2", undefined, "AskUserQuestion", INPUT, 10, []);
  const card = document.querySelector(".blk-question");
  await card.settle({ behavior: "allow", updatedInput: { questions: INPUT.questions, answers: { "Which drawer?": "Left" } } });
  h.relay.refresh();
  window.removeEventListener("vidar-ask-settled", on);
  assert.equal(items().length, 0);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { key: "q2", where: "Vidar Work", answer: "Left" });
  assert.notEqual(card.querySelector(".approval-result").title, "Answered in Relay");
  h.relay.dispose();
});

test("a Relay answer settles once, a second throws Already Answered, and the check says Answered in Relay", async () => {
  document.body.replaceChildren();
  const h = harness("t-relay");
  const events = [];
  const on = (e) => events.push(e.detail);
  window.addEventListener("vidar-ask-settled", on);
  h.cards.approvalCard("q3", undefined, "AskUserQuestion", INPUT, 10, []);
  const [it] = items();
  const reply = { answers: { [it.view.record.questions[0].id]: "Right" }, notes: "" };
  await it.resolve({ verdict: "approve", comment: "", reply });
  assert.equal(h.sent.length, 1); // one answer went out, not two
  assert.equal(h.approvals.size, 0);
  await assert.rejects(it.resolve({ verdict: "approve", comment: "", reply }), /Already Answered/);
  const glyph = document.querySelector(".approval-result");
  assert.equal(glyph.title, "Answered in Relay");
  assert.equal(items().length, 0);
  window.removeEventListener("vidar-ask-settled", on);
  assert.equal(events.length, 0); // a Relay answer is not a chat answer
  assert.equal(document.querySelector(".blk-question").dataset.relayAnswer, undefined);
  h.relay.dispose();
});

test("a subagent question carries the agent text as context, a main-thread one has none", () => {
  document.body.replaceChildren();
  const box = document.createElement("div");
  box.className = "tool-children";
  document.body.appendChild(box);
  const tools = new Map([["a1", { children: box, subagentType: "Explore", subagentDesc: "Find drawers" }]]);
  const h = harness("t-ctx");
  h.relay.dispose();
  const relay = createQuestionRelay({ tabId: "t-ctx", tabName: "Vidar Work", tools, openQuestions: () => h.cards.openQuestions(), hydrating: () => false });
  h.cards.approvalCard("qs", undefined, "AskUserQuestion", INPUT, 10, []);
  h.cards.approvalCard("qm", undefined, "AskUserQuestion", INPUT, 11, []);
  box.appendChild(document.querySelector('[data-ask-key="qs"]'));
  relay.refresh();
  const byKey = (k) => items().find((i) => i.id.endsWith(`:${k}`)).view.record;
  assert.equal(byKey("qs").context, "Explore · Find drawers");
  assert.equal(byKey("qm").context, undefined);
  relay.dispose();
});

test("nothing publishes while hydrating", () => {
  document.body.replaceChildren();
  const h = harness("t-hyd");
  h.S.hydrating = true;
  h.cards.approvalCard("q4", undefined, "AskUserQuestion", INPUT, 10, []);
  assert.equal(items().length, 0);
  h.S.hydrating = false;
  h.relay.refresh();
  assert.equal(items().length, 1);
  h.relay.dispose();
});
