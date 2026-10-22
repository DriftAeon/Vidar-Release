// Codex request_user_input_async: an agentMessage with delivery "async" and questions draws the
// Question card (not the flattened text), Answer sends `<title>: <choice>` as the next user
// message, and a replayed ask with a later user message reads as answered.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { CodexAdapter } = await import("../src/agents/codex.ts");
const { asyncAskQuestions, asyncAnswerText } = await import("../src/agents/codex-async-ask.ts");
const { createCards } = await import("../src/panels/rendered/cards.ts");
const { createEvents } = await import("../src/panels/rendered/events.ts");
const { DRIVE_CLASS } = await import("../src/panels/rendered-drive.ts");

const ASK = { id: "call-1", type: "agentMessage", phase: "final_answer", delivery: "async",
  text: "Pick a colour\n- Blue\n- Green", questions: [{ title: "Pick a colour", options: ["Blue", "Green"] }] };

function harness(resume) {
  const adapter = new CodexAdapter(), wire = [];
  adapter.attach((line) => wire.push(JSON.parse(line)));
  adapter.start({ cwd: "C:/work", permissionMode: "default", resume });
  const request = (method) => wire.findLast((m) => m.method === method);
  const reply = (method, result) => adapter.feed(JSON.stringify({ id: request(method).id, result }));
  reply("initialize", {});
  reply(resume ? "thread/resume" : "thread/start", { thread: { id: "t" } });
  const note = (method, params) => adapter.feed(JSON.stringify({ method, params: { threadId: "t", turnId: "turn-1", ...params } }));
  return { adapter, reply, note };
}

function ui({ sendText = () => true } = {}) {
  const host = document.createElement("div"), approvals = new Map(), sent = [];
  const S = { hydrating: false, replaying: false, stick: false, pendingApproval: null, adapter: {} };
  const cards = createCards(S, {
    agent: "codex", transport: { durable: false }, textarea: document.createElement("textarea"),
    follow: { toBottom() {} }, tools: new Map(), approvals, approvalQueue: [], awaiting: new Map(),
    sendEncoded: async () => true, append: (n) => host.append(n), sealGroup() {}, groupRefresh() {},
    stalePill() {}, refreshState() {}, noticeBlock() {},
    sendText: (text) => { sent.push(text); return sendText(text); },
  });
  const texts = [];
  const { handle } = createEvents(S, {
    tools: new Map(), sealGroup() {}, setInTurn() {}, settleThoughts() {}, userBlock: (t) => texts.push(`user:${t}`),
    textDone: (id, md) => texts.push(`text:${md}`), asyncAskCard: cards.asyncAskCard, settleAsyncAsks: cards.settleAsyncAsks,
  });
  const card = () => host.querySelector(`.${DRIVE_CLASS.card}`);
  return { S, host, approvals, sent, texts, handle, card };
}

test("detection: only an async agentMessage with a titled question is an ask", () => {
  assert.deepEqual(asyncAskQuestions(ASK), [{ title: "Pick a colour", options: ["Blue", "Green"] }]);
  assert.equal(asyncAskQuestions({ ...ASK, delivery: null }), null);
  assert.equal(asyncAskQuestions({ ...ASK, questions: [] }), null);
  assert.equal(asyncAskQuestions({ ...ASK, questions: null }), null);
  assert.equal(asyncAskQuestions({ ...ASK, questions: [{ title: " " }] }), null);
  assert.deepEqual(asyncAskQuestions({ ...ASK, questions: [{ title: "Why?", options: null }] }), [{ title: "Why?", options: [] }]);
});

test("live: deltas are not drawn and completion gives the card in place of the text", () => {
  const h = harness();
  assert.deepEqual(h.note("item/started", { item: { ...ASK, text: "" } }), []);
  assert.deepEqual(h.note("item/agentMessage/delta", { itemId: "call-1", delta: "Pick a colour" }), []);
  const done = h.note("item/completed", { item: ASK });
  assert.deepEqual(done, [
    { kind: "text_done", blockId: "call-1", markdown: "", parentToolUseId: null },
    { kind: "ask_async", blockId: "call-1", questions: [{ title: "Pick a colour", options: ["Blue", "Green"] }] },
  ]);
  const plain = h.note("item/completed", { item: { id: "m2", type: "agentMessage", text: "Hi" } });
  assert.deepEqual(plain, [{ kind: "text_done", blockId: "m2", markdown: "Hi", parentToolUseId: null }]);
});

test("answer text: one line per question, notes after a blank line", () => {
  const qs = [{ title: "Pick a colour", options: ["Blue"] }, { title: "Size", options: [] }];
  assert.equal(asyncAnswerText(qs.slice(0, 1), { q0: "Blue" }), "Pick a colour: Blue");
  assert.equal(asyncAnswerText(qs, { q0: "Blue", q1: "Large" }, " Soon "), "Pick a colour: Blue\nSize: Large\n\nSoon");
});

test("Answer sends the pick as a user message, folds the card and never holds the composer", () => {
  const u = ui();
  u.handle({ kind: "ask_async", blockId: "call-1", questions: [{ title: "Pick a colour", options: ["Blue", "Green"] }] });
  const card = u.card();
  assert.ok(card.classList.contains("blk-question"));
  assert.equal(u.approvals.size, 0, "not a pending approval");
  assert.equal(u.S.pendingApproval, null);
  const answer = card.querySelector(`.${DRIVE_CLASS.allow}`);
  assert.equal(answer.disabled, true, "nothing picked yet");
  [...card.querySelectorAll(`.${DRIVE_CLASS.option}`)].find((b) => b.dataset.label === "Green").click();
  assert.equal(answer.disabled, false);
  card.querySelector(`.${DRIVE_CLASS.message}`).value = "Dark shade";
  answer.click();
  assert.deepEqual(u.sent, ["Pick a colour: Green\n\nDark shade"]);
  assert.ok(card.classList.contains(DRIVE_CLASS.settled));
  assert.equal(card.querySelector(".approval-body"), null, "folds to its head row");
  assert.equal(card.querySelector(`.${DRIVE_CLASS.result}`).title, "Answered");
});

test("a refused send leaves the card actionable", async () => {
  const u = ui({ sendText: () => Promise.resolve(false) });
  u.handle({ kind: "ask_async", blockId: "a", questions: [{ title: "Q", options: ["Yes"] }] });
  u.card().querySelector(`.${DRIVE_CLASS.option}`).click();
  u.card().querySelector(`.${DRIVE_CLASS.allow}`).click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!u.card().classList.contains(DRIVE_CLASS.settled));
});

test("replay: an ask with a later user message shows as answered; the last open one stays actionable", () => {
  const h = harness("old");
  const events = h.reply("thread/turns/list", { data: [
    { id: "turn-a", items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "Ask me" }] }, ASK] },
    { id: "turn-b", items: [{ type: "userMessage", id: "u2", content: [{ type: "text", text: "Pick a colour: Blue" }] },
      { ...ASK, id: "call-2", questions: [{ title: "Pick a size", options: ["S", "M"] }] }] },
  ] });
  assert.deepEqual(events.filter((e) => e.kind === "ask_async").map((e) => e.blockId), ["call-1", "call-2"]);
  assert.ok(!events.some((e) => e.kind === "text_done" && e.markdown), "flattened text never drawn");
  const u = ui();
  for (const ev of events) if (ev.kind !== "replay") u.handle(ev); // the boundaries need the whole body
  const [first, second] = u.host.querySelectorAll(`.${DRIVE_CLASS.card}`);
  assert.ok(first.classList.contains(DRIVE_CLASS.settled), "answered by the later user message");
  assert.equal(first.querySelector(`.${DRIVE_CLASS.allow}`), null);
  assert.ok(!second.classList.contains(DRIVE_CLASS.settled), "no later message: still open");
  u.handle({ kind: "turn_start" });
  assert.ok(second.classList.contains(DRIVE_CLASS.settled), "a new turn answers it too");
});
