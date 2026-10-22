// Codex ThreadItem types mapped by src/agents/codex-items.ts: each one, live and replayed from
// history, lands as a readable tool pill or a notice line, never the raw-JSON fallback pill.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { CodexAdapter } = await import("../src/agents/codex.ts");
const { shortDuration } = await import("../src/agents/codex-items.ts");
const { toolSummary } = await import("../src/panels/rendered/format.ts");

function harness(resume) {
  const adapter = new CodexAdapter(), wire = [];
  adapter.attach((line) => wire.push(JSON.parse(line)));
  adapter.start({ cwd: "C:/work", permissionMode: "default", resume });
  const request = (method) => wire.findLast((m) => m.method === method);
  const reply = (method, result) => adapter.feed(JSON.stringify({ id: request(method).id, result }));
  reply("initialize", {});
  reply(resume ? "thread/resume" : "thread/start", { thread: { id: "t" } });
  const note = (method, params) => adapter.feed(JSON.stringify({ method, params: { threadId: "t", turnId: "turn-1", ...params } }));
  return { reply, note };
}

const FIXTURES = {
  dynamicToolCall: { id: "d1", type: "dynamicToolCall", tool: "lookup", namespace: "kb", arguments: { q: "tabs" }, status: "completed", success: true,
    contentItems: [{ type: "inputText", text: "Found 3" }, { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" }], durationMs: 12 },
  imageView: { id: "v1", type: "imageView", path: "C:/work/shot.png" },
  imageGeneration: { id: "g1", type: "imageGeneration", status: "completed", result: "QUJD", revisedPrompt: "A red fox", savedPath: "C:/work/fox.png" },
  sleep: { id: "s1", type: "sleep", durationMs: 1500 },
  subAgentActivity: { id: "a1", type: "subAgentActivity", agentPath: "reviewer", agentThreadId: "thr-9", kind: "started" },
  hookPrompt: { id: "h1", type: "hookPrompt", fragments: [{ hookRunId: "r1", text: "Run the linter first" }] },
  functionCallOutput: { id: "f1", type: "functionCallOutput", name: "read_file", namespace: null, output: "file body" },
  enteredReviewMode: { id: "e1", type: "enteredReviewMode", review: "current changes" },
  exitedReviewMode: { id: "x1", type: "exitedReviewMode", review: "No issues found" },
  contextCompaction: { id: "c1", type: "contextCompaction" },
};

const EXPECT = {
  dynamicToolCall: { name: "kb.lookup", input: { q: "tabs" }, content: "Found 3\n[Image]" },
  imageView: { name: "Read", input: { file_path: "C:/work/shot.png" }, content: "C:/work/shot.png", summary: "C:/work/shot.png" },
  imageGeneration: { name: "Image", content: "C:/work/fox.png\nA red fox", summary: "A red fox" },
  sleep: { name: "Sleep", input: { duration: "1.5s" }, content: "", summary: "1.5s" },
  subAgentActivity: { name: "Subagent", content: "", summary: "reviewer · Started" },
  functionCallOutput: { name: "read_file", input: {}, content: "file body" },
  hookPrompt: { notice: "Hook Prompt: Run the linter first" },
  enteredReviewMode: { notice: "Review Started: current changes" },
  exitedReviewMode: { notice: "Review Finished: No issues found" },
  contextCompaction: { notice: "Context Compacted" },
};

function check(type, events) {
  const want = EXPECT[type], item = FIXTURES[type];
  for (const e of events) {
    if (e.kind === "tool_start") assert.notEqual(e.name, type, `${type}: no pill named after the item type`);
    if (e.kind === "tool_start") assert.notEqual(e.input, item, `${type}: input is not the item JSON`);
    if (e.kind === "tool_done") assert.ok(!e.content.includes(`"type": "${type}"`), `${type}: content is not the item JSON`);
    assert.notEqual(e.kind, "unknown");
  }
  if (want.notice) {
    assert.deepEqual(events, [{ kind: "notice", text: want.notice, level: "info" }], type);
    return;
  }
  const start = events.filter((e) => e.kind === "tool_start"), done = events.filter((e) => e.kind === "tool_done");
  assert.equal(start.length, 1, `${type}: one pill`);
  assert.equal(done.length, 1, `${type}: one result`);
  assert.equal(start[0].name, want.name, type);
  if (want.input) assert.deepEqual(start[0].input, want.input, type);
  assert.equal(done[0].content, want.content, type);
  assert.equal(done[0].isError, false, type);
  if (want.summary !== undefined) assert.equal(toolSummary(start[0].name, start[0].input), want.summary, type);
}

for (const type of Object.keys(FIXTURES)) {
  test(`live ${type}: started + completed map without the raw fallback`, () => {
    const h = harness();
    const events = [...h.note("item/started", { item: FIXTURES[type] }), ...h.note("item/completed", { item: FIXTURES[type] })];
    check(type, events);
  });

  test(`history ${type}: replay maps without the raw fallback`, () => {
    const h = harness("old-thread");
    const replay = h.reply("thread/turns/list", { data: [{ id: "old-turn", items: [FIXTURES[type]] }], nextCursor: null });
    check(type, replay.filter((e) => e.kind !== "replay"));
  });
}

test("a completed pill item that never started opens its pill first", () => {
  const h = harness();
  const events = h.note("item/completed", { item: FIXTURES.sleep });
  assert.deepEqual(events.map((e) => e.kind), ["tool_start", "tool_done"]);
});

test("failures settle as errors with readable text", () => {
  const h = harness();
  const failedTool = { ...FIXTURES.dynamicToolCall, status: "failed", success: false, contentItems: [{ type: "inputText", text: "No such key" }] };
  const [toolDone] = h.note("item/completed", { item: failedTool }).filter((e) => e.kind === "tool_done");
  assert.deepEqual([toolDone.isError, toolDone.content], [true, "No such key"]);
  const failedImage = { id: "g2", type: "imageGeneration", status: "failed", result: "", failure: { type: "usageLimitExceeded", limitId: "img" } };
  const [imageDone] = h.note("item/completed", { item: failedImage }).filter((e) => e.kind === "tool_done");
  assert.deepEqual([imageDone.isError, imageDone.content], [true, "Image generation failed: usage limit exceeded (img)"]);
});

test("shortDuration", () => {
  assert.deepEqual([900, 5000, 1500, 125000, 120000].map(shortDuration), ["900ms", "5s", "1.5s", "2m 5s", "2m"]);
});
