// Block ids of the Claude adapter: a complete assistant record the stream never opened (a failed
// API call's error record) gets a fresh id, never the previous reply's, and a subagent's stream
// events never touch the main message's stream state.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { ClaudeAdapter } = await import("../src/agents/claude.ts");

const se = (event, extra = {}) => JSON.stringify({ type: "stream_event", event, ...extra });
const asst = (id, text) => JSON.stringify({ type: "assistant", message: { ...(id ? { id } : {}), role: "assistant", content: [{ type: "text", text }] } });
const feedAll = (a, lines) => lines.flatMap((l) => a.feed(l));
const doneIds = (evs) => evs.filter((e) => e.kind === "text_done").map((e) => e.blockId);

function streamedReply(a, id, text) {
  return feedAll(a, [
    se({ type: "message_start", message: { id } }),
    se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    se({ type: "content_block_stop", index: 0 }),
    asst(id, text),
  ]);
}

test("an error record with its own message id never reuses the previous reply's block", () => {
  const a = new ClaudeAdapter();
  const [prev] = doneIds(streamedReply(a, "msg_A", "first reply"));
  const [err] = doneIds(a.feed(asst("msg_B", "API Error: 529 overloaded")));
  assert.ok(prev && err, "no text_done");
  assert.notEqual(err, prev, "the error record overwrote the previous reply");
});

test("an error record with no message id never reuses the previous reply's block", () => {
  const a = new ClaudeAdapter();
  const [prev] = doneIds(streamedReply(a, "msg_A", "first reply"));
  const [err] = doneIds(a.feed(asst(null, "API Error: connection reset")));
  assert.notEqual(err, prev, "the error record overwrote the previous reply");
});

test("the complete record of a streamed message still lands on its streamed block", () => {
  const a = new ClaudeAdapter();
  const evs = streamedReply(a, "msg_A", "hello");
  const delta = evs.find((e) => e.kind === "text_delta");
  assert.deepEqual(doneIds(evs), [delta.blockId]);
});

test("a non-streaming retry after an abandoned stream leaves exactly one reply", () => {
  // probe: message_start A → text_delta "par" → assistant(B, text) left the partial m1:0 drawn
  const a = new ClaudeAdapter();
  const streamed = feedAll(a, [
    se({ type: "message_start", message: { id: "msg_A" } }),
    se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "par" } }),
  ]);
  const partial = streamed.find((e) => e.kind === "text_delta").blockId;
  const done = a.feed(asst("msg_B", "partial reply, in full")).filter((e) => e.kind === "text_done");
  const closed = done.filter((e) => e.blockId === partial);
  assert.deepEqual(closed.map((e) => e.markdown), [""], "the abandoned partial block was not closed empty");
  const shown = done.filter((e) => e.markdown.trim());
  assert.equal(shown.length, 1, "not exactly one reply drawn");
  assert.notEqual(shown[0].blockId, partial);
});

test("a streaming retry after an abandoned stream closes the stale preview empty", () => {
  // probe: message_start A → text_delta "par" → stream error → message_start A2 streams again
  const a = new ClaudeAdapter();
  const first = feedAll(a, [
    se({ type: "message_start", message: { id: "msg_A" } }),
    se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "par" } }),
  ]);
  const partial = first.find((e) => e.kind === "text_delta").blockId;
  const thought = first.find((e) => e.kind === "thinking").blockId;
  const retry = a.feed(se({ type: "message_start", message: { id: "msg_A2" } }));
  assert.deepEqual(retry.filter((e) => e.kind === "text_done").map((e) => [e.blockId, e.markdown]), [[partial, ""]], "the stale preview was not closed empty");
  assert.deepEqual(retry.filter((e) => e.kind === "thinking").map((e) => [e.blockId, e.done]), [[thought, true]], "the abandoned thought stayed open");
  const evs = streamedReply(a, "msg_A2", "partial reply, in full");
  const shown = doneIds(evs);
  assert.equal(shown.length, 1);
  assert.notEqual(shown[0], partial, "the retry landed on the stale block");
});

test("a message_start after a fully claimed message closes nothing", () => {
  const a = new ClaudeAdapter();
  streamedReply(a, "msg_A", "first");
  const next = a.feed(se({ type: "message_start", message: { id: "msg_B" } }));
  assert.deepEqual(next.filter((e) => e.kind !== "turn_start"), []);
});

test("a redacted_thinking record never wipes the text block still streaming", () => {
  // probe: thinking streamed at 0, text started at 1, the complete thinking arrives redacted
  const a = new ClaudeAdapter();
  const lines = [
    se({ type: "message_start", message: { id: "msg_A" } }),
    se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    se({ type: "content_block_stop", index: 0 }),
    se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "he" } }),
  ];
  const textId = feedAll(a, lines).find((e) => e.kind === "text_delta").blockId;
  a.feed(JSON.stringify({ type: "assistant", message: { id: "msg_A", content: [{ type: "redacted_thinking", data: "x" }] } }));
  const more = a.feed(se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "llo" } }));
  assert.deepEqual(more.map((e) => [e.kind, e.blockId]), [["text_delta", textId]], "later text deltas were dropped");
  assert.deepEqual(doneIds(a.feed(asst("msg_A", "hello"))), [textId], "the text landed off its streamed block");
});

test("subagent block ids never repeat across subagent messages", () => {
  const a = new ClaudeAdapter();
  const subRec = (text) => JSON.stringify({ type: "assistant", parent_tool_use_id: "toolu_1", message: { id: `msg_${text}`, content: [{ type: "text", text }] } });
  const ids = [subRec("one"), subRec("two")].flatMap((l) => doneIds(a.feed(l)));
  assert.equal(new Set(ids).size, 2, `subagent ids repeated: ${ids}`);
});

test("subagent stream events are dropped and leave the main stream intact", () => {
  const a = new ClaudeAdapter();
  feedAll(a, [
    se({ type: "message_start", message: { id: "msg_A" } }),
    se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ]);
  const sub = feedAll(a, [
    se({ type: "message_start", message: { id: "msg_S" } }, { parent_tool_use_id: "toolu_1" }),
    se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { parent_tool_use_id: "toolu_1" }),
    se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub" } }, { parent_tool_use_id: "toolu_1" }),
  ]);
  assert.deepEqual(sub, [], "subagent stream events rendered");
  const main = a.feed(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "main" } }));
  assert.deepEqual(main.map((e) => [e.kind, e.text]), [["text_delta", "main"]], "the main stream lost its block");
});
