// tools\claude-sidecar-shrink.mjs: shrunk tool results never exceed CAP bytes of JSON, an
// oversize text block is truncated with a marker rather than dropped, truncation terminates and
// wastes no budget, and one whole message stays under MESSAGE_CAP (the Rust readers drop a line over 8 MiB).
//
//   node --test tests\sidecar-shrink-cap.test.mjs
// SHRINK_SRC (file URL) points the test at another copy of the module, for fail-before runs.
import test from "node:test";
import assert from "node:assert/strict";

const mod = await import(process.env.SHRINK_SRC ?? new URL("../tools/claude-sidecar-shrink.mjs", import.meta.url).href);
const { CAP, bytes, shrink, summarizeInput } = mod;
const MESSAGE_CAP = mod.MESSAGE_CAP ?? 4 * 1024 * 1024;

const result = (content) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content }] } });
const out = (msg) => shrink(msg).message.content[0].content;
const line = (msg) => Buffer.byteLength(JSON.stringify(shrink(msg)), "utf8");

test("9 MiB text line becomes one truncated, marked line within CAP", () => {
  const c = out(result([{ type: "text", text: "x".repeat(9 * 1024 * 1024) }]));
  assert.ok(bytes(c) <= CAP, `array content ${bytes(c)} > CAP`);
  assert.equal(c.length, 1);
  assert.match(c[0].text, /\[truncated: \d+ bytes\]$/);
});

test("kept blocks plus a truncated block stay within CAP", () => {
  const c = out(result([{ type: "text", text: "a".repeat(200 * 1024) }, { type: "text", text: "b".repeat(200 * 1024) }]));
  assert.ok(bytes(c) <= CAP, `array content ${bytes(c)} > CAP`);
  assert.equal(c.length, 2);
  assert.match(c[1].text, /\[truncated: /);
});

test("string content with escape-heavy text stays within CAP", () => {
  const c = out(result('"\n'.repeat(400 * 1024)));
  assert.ok(bytes(c) <= CAP, `string content ${bytes(c)} > CAP`);
  assert.match(c, /\[truncated: \d+ bytes\]$/);
});

test("ASCII truncation lands within 16 bytes of the budget", () => {
  const c = out(result("x".repeat(1024 * 1024)));
  assert.ok(bytes(c) <= CAP && bytes(c) >= CAP - 16, `got ${bytes(c)} of ${CAP}`);
});

test("all-\\u0001 text with a tiny budget terminates within budget", () => {
  const big = "\u0001".repeat(10000);
  const c = summarizeInput("x", { file_path: big }).file_path; // 4 KiB field budget, 6 bytes per char
  assert.ok(bytes(c) <= 4096, `${bytes(c)} > 4096`);
  assert.match(c, /\[truncated: /);
});

test("a later small block survives an earlier oversize non-text block", () => {
  const c = out(result([{ type: "image", source: { type: "base64", data: "A".repeat(CAP * 2) } }, { type: "text", text: "tail" }]));
  assert.deepEqual(c, [{ type: "text", text: "tail" }]);
});

test("summarized input fields are capped", () => {
  const s = summarizeInput("Read", { file_path: "p".repeat(100000), url: "u".repeat(100000) });
  assert.ok(bytes(s.file_path) <= 4096 && bytes(s.url) <= 4096);
});

test("40 x 1 MiB tool results emit one line within MESSAGE_CAP", () => {
  const content = Array.from({ length: 40 }, (_, i) => ({ type: "tool_result", tool_use_id: `t${i}`, content: "r".repeat(1024 * 1024) }));
  const n = line({ type: "user", message: { content } });
  assert.ok(n <= MESSAGE_CAP, `${n} > ${MESSAGE_CAP}`);
});

test("40 images of 200 KB (each within CAP) emit one line within MESSAGE_CAP", () => {
  const content = Array.from({ length: 40 }, () => ({ type: "image", source: { type: "base64", data: "A".repeat(200 * 1024) } }));
  const m = shrink({ type: "user", message: { content } });
  assert.ok(Buffer.byteLength(JSON.stringify(m), "utf8") <= MESSAGE_CAP);
  assert.equal(m.message.content.length, 40);
});

test("a 9 MiB string user message emits one marked line within MESSAGE_CAP", () => {
  const m = shrink({ type: "user", message: { content: "x".repeat(9 * 1024 * 1024) } });
  assert.ok(Buffer.byteLength(JSON.stringify(m), "utf8") <= MESSAGE_CAP);
  assert.match(m.message.content, /\[truncated: \d+ bytes\]$/);
});

test("a 9 MiB top-level image emits one line within MESSAGE_CAP, as a placeholder", () => {
  const msg = { type: "user", message: { content: [{ type: "image", source: { type: "base64", data: "A".repeat(9 * 1024 * 1024) } }, { type: "text", text: "hi" }] } };
  const m = shrink(msg);
  assert.ok(Buffer.byteLength(JSON.stringify(m), "utf8") <= MESSAGE_CAP);
  assert.match(m.message.content[0].text, /^\[image omitted: \d+ bytes\]$/);
  assert.equal(m.message.content[1].text, "hi");
});
