// Reordered and failed app-server responses must not strand drafts or end a newer turn.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { CodexAdapter } = await import("../src/agents/codex.ts");

function harness(resume, answerRead = true) {
  const adapter = new CodexAdapter(), wire = [];
  adapter.attach((line) => wire.push(JSON.parse(line)));
  const feed = (m) => adapter.feed(JSON.stringify(m));
  const request = (method) => wire.findLast((m) => m.method === method);
  const reply = (method, result) => feed({ id: request(method).id, result });
  const fail = (method) => feed({ id: request(method).id, error: { code: -1, message: "offline" } });
  const note = (method, params) => feed({ method, params: { threadId: "thread", ...params } });
  adapter.start({ cwd: "C:/work", permissionMode: "default", resume });
  reply("initialize", {});
  if (answerRead) reply("account/read", { account: { type: "apiKey" }, requiresOpenaiAuth: true }); // turns wait for it
  reply(resume ? "thread/resume" : "thread/start", { thread: { id: "thread" } });
  return { adapter, wire, feed, request, reply, fail, note };
}

test("failed history page ends replay and returns queued drafts without dispatching them", () => {
  const h = harness("thread");
  h.reply("thread/turns/list", { data: [{ id: "old", items: [] }], nextCursor: "next" });
  h.adapter.encodeUser("First draft");
  h.adapter.encodeUser("Second draft");
  const events = h.fail("thread/turns/list");
  assert.deepEqual(events.find((e) => e.kind === "replay"), { kind: "replay", phase: "end", count: 1, truncated: 1 });
  assert.deepEqual(events.filter((e) => e.kind === "send_failed").map((e) => e.text), ["First draft\nSecond draft"]);
  assert.equal(h.request("turn/start"), undefined);
  h.adapter.encodeUser("Explicit retry");
  assert.equal(h.request("turn/start").params.input[0].text, "Explicit retry");
});

test("malformed and cycling history pages return drafts instead of silently dispatching", () => {
  for (const malformed of [{}, { data: null }, { data: [null] }]) {
    const h = harness("thread");
    h.adapter.encodeUser("Keep me");
    const events = h.reply("thread/turns/list", malformed);
    assert.ok(events.some((e) => e.kind === "send_failed" && e.text === "Keep me"));
    assert.equal(h.request("turn/start"), undefined);
  }
  const h = harness("thread");
  h.reply("thread/turns/list", { data: [{ id: "old", items: [] }], nextCursor: "same" });
  h.adapter.encodeUser("Keep me");
  const events = h.reply("thread/turns/list", { data: [{ id: "older", items: [] }], nextCursor: "same" });
  assert.ok(events.some((e) => e.kind === "send_failed" && e.text === "Keep me"));
  assert.equal(h.wire.filter((m) => m.method === "thread/turns/list").length, 2);
});

test("duplicate or late completion cannot settle a newer turn's cards or interrupt state", () => {
  for (const alreadySeen of [false, true]) {
    const h = harness();
    if (alreadySeen) h.note("turn/completed", { turn: { id: "old", status: "completed" } });
    h.note("turn/started", { turn: { id: "new" } });
    h.feed({ id: 501, method: "item/commandExecution/requestApproval", params: {
      threadId: "thread", turnId: "new", itemId: "tool", command: "test", cwd: "C:/work",
    } });
    const late = h.note("turn/completed", { turn: { id: "old", status: "completed" } });
    assert.deepEqual(late, []);
    h.adapter.encodePermission("sr:501", { behavior: "allow" });
    assert.equal(h.wire.findLast((m) => m.id === 501).result.decision, "accept");
    h.adapter.encodeInterrupt();
    assert.equal(h.request("turn/interrupt").params.turnId, "new");
  }
});

test("late turn start events and responses cannot resurrect a completed turn", () => {
  const h = harness();
  h.adapter.encodeUser("One");
  h.note("turn/completed", { turn: { id: "one", status: "completed" } });
  assert.deepEqual(h.note("turn/started", { turn: { id: "one" } }), []);
  h.reply("turn/start", { turn: { id: "one" } });
  assert.equal(h.adapter.turnId, null);
});

test("a rejected turn start clears an early Stop before the next explicit attempt", () => {
  const h = harness();
  h.adapter.encodeUser("First");
  h.adapter.encodeInterrupt();
  assert.ok(h.fail("turn/start").some((e) => e.kind === "send_failed"));
  h.adapter.encodeUser("Retry");
  h.reply("turn/start", { turn: { id: "retry" } });
  assert.equal(h.request("turn/interrupt"), undefined);
});

test("a late turn/start reply cannot steal Stop from the active turn", () => {
  const h = harness();
  h.adapter.encodeUser("Old request");
  h.note("turn/started", { turn: { id: "new" } });
  h.reply("turn/start", { turn: { id: "old" } });
  h.adapter.encodeInterrupt();
  assert.equal(h.request("turn/interrupt").params.turnId, "new");
});

test("late item and usage notifications cannot leak into a newer turn", () => {
  const h = harness();
  h.note("turn/completed", { turn: { id: "old", status: "completed" } });
  h.note("turn/started", { turn: { id: "new" } });
  for (const [method, payload] of [
    ["item/agentMessage/delta", { itemId: "text", delta: "stale" }],
    ["item/commandExecution/outputDelta", { itemId: "tool", delta: "stale" }],
    ["item/completed", { item: { id: "text", type: "agentMessage", text: "stale" } }],
    ["thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 123 } } }],
  ]) assert.deepEqual(h.note(method, { turnId: "old", ...payload }), []);
  assert.deepEqual(h.note("item/agentMessage/delta", { turnId: "new", itemId: "text", delta: "live" }),
    [{ kind: "text_delta", blockId: "text", text: "live" }]);
  const done = h.note("turn/completed", { turn: { id: "new", status: "completed" } });
  assert.equal(done.find((e) => e.kind === "turn_done").usage, null);
});

test("history overlap renders each turn once and keeps drafts queued through pagination", () => {
  const h = harness("thread");
  const turn = (id) => ({ id, items: [{ type: "userMessage", content: [{ type: "text", text: id }] }] });
  h.adapter.encodeUser("Queued");
  const first = h.reply("thread/turns/list", { data: [turn("one")], nextCursor: "next" });
  assert.equal(h.request("turn/start"), undefined);
  const second = h.reply("thread/turns/list", { data: [turn("one"), turn("two")] });
  assert.deepEqual([...first, ...second].filter((e) => e.kind === "user_echo").map((e) => e.text), ["one", "two"]);
  assert.equal(second.find((e) => e.kind === "replay").count, 2);
  assert.equal(h.request("turn/start").params.input[0].text, "Queued");
});

// account/read answered AFTER thread/resume and every history page: replay must not release a turn past the login gate
function replayBeforeRead() {
  const h = harness("thread", false);
  const turn = (id) => ({ id, items: [{ type: "userMessage", content: [{ type: "text", text: id }] }] });
  h.reply("thread/turns/list", { data: [turn("one")], nextCursor: "next" });
  h.adapter.encodeUser("Mid replay");
  h.reply("thread/turns/list", { data: [turn("two")] });
  h.adapter.encodeUser("After replay");
  return h;
}
const turnTexts = (h) => h.wire.filter((m) => m.method === "turn/start").map((m) => m.params.input[0].text);

test("Codex turns wait for account/read when the replay finishes first, then go once per draft in order", () => {
  const h = replayBeforeRead();
  assert.deepEqual(turnTexts(h), [], "no turn/start before account/read is answered");
  h.reply("account/read", { account: { type: "apiKey" }, requiresOpenaiAuth: true });
  assert.deepEqual(turnTexts(h), ["Mid replay", "After replay"]);
});

test("Codex drafts typed around a replay come back as send_failed when account/read says logged out", () => {
  const h = replayBeforeRead();
  assert.deepEqual(turnTexts(h), []);
  const events = h.reply("account/read", { account: null, requiresOpenaiAuth: true });
  assert.deepEqual(events.filter((e) => e.kind === "send_failed").map((e) => e.text), ["Mid replay", "After replay"]);
  assert.deepEqual(turnTexts(h), []);
});
