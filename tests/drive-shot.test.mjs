// shot options, hash-skip, look cap and --file mode: fake CDP session and a stubbed claude runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseShotOpts, captureParams, clipKey, countLook } from "../tools/drive/shot-opts.mjs";
import { shot } from "../tools/drive/verbs/basic.mjs";
import { runLook, parseClaude } from "../tools/drive/verbs/look.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "drive-shot-"));
const PNG = Buffer.from("fake-png-bytes").toString("base64");

function fakeCtx({ flags = {}, a1, data = PNG, rect = { x: 10, y: 20, width: 100, height: 50 } } = {}) {
  const calls = [];
  const evalJs = async (js) => {
    calls.push({ eval: js });
    if (js.includes("innerWidth")) return { x: 0, y: 0, width: 800, height: 600 };
    if (js.includes("getBoundingClientRect")) return rect;
    return true;
  };
  const send = async (method, params) => { calls.push({ method, params }); return { data }; };
  return { ctx: { a1, flags, send, evalJs, q: JSON.stringify, withTimeout: (p) => p, EVAL_MS: 1000 }, calls };
}
const capture = (calls) => calls.find((c) => c.method === "Page.captureScreenshot").params;

test("no flags: png, no clip, same return as before", async () => {
  const dir = tmp(); const out = path.join(dir, "a.png");
  const { ctx, calls } = fakeCtx({ a1: out });
  assert.equal(await shot(ctx), `wrote ${out}`);
  assert.deepEqual(capture(calls), { format: "png" });
  assert.ok(fs.existsSync(out));
});

test("clip rect math: rect carries scale, jpeg adds quality", async () => {
  const dir = tmp(); const out = path.join(dir, "b.jpg");
  const { ctx, calls } = fakeCtx({ flags: { clip: "#x", scale: "0.5", jpeg: "70", out } });
  await shot(ctx);
  assert.deepEqual(capture(calls), { format: "jpeg", quality: 70, clip: { x: 10, y: 20, width: 100, height: 50, scale: 0.5 } });
});

test("scale without clip clips to the viewport", async () => {
  const dir = tmp();
  const { ctx, calls } = fakeCtx({ flags: { scale: "0.25", out: path.join(dir, "c.png") } });
  await shot(ctx);
  assert.deepEqual(capture(calls), { format: "png", clip: { x: 0, y: 0, width: 800, height: 600, scale: 0.25 } });
});

test("option validation", () => {
  assert.throws(() => parseShotOpts({ scale: "2" }), /0.1-1/);
  assert.throws(() => parseShotOpts({ jpeg: "0" }), /1-100/);
  assert.throws(() => parseShotOpts({ clip: true }), /needs a value/);
  assert.throws(() => captureParams(parseShotOpts({ clip: "#x" }), { x: 0, y: 0, width: 0, height: 5 }), /no area/);
  assert.equal(clipKey(parseShotOpts({ scale: "0.5" })), "viewport|0.5|png");
});

test("hash-skip: equal bytes write nothing and return the previous path; different bytes write", async () => {
  const dir = tmp(); const run = path.join(dir, "run");
  process.env.VIDAR_EXPLORER_RUN = run;
  try {
    const p1 = path.join(dir, "1.jpg"), p2 = path.join(dir, "2.jpg"), p3 = path.join(dir, "3.jpg");
    const f = { clip: "#x", jpeg: "80" };
    const r1 = await shot(fakeCtx({ flags: { ...f, out: p1 } }).ctx);
    assert.equal(r1.path, p1);
    const same = fakeCtx({ flags: { ...f, out: p2 } });
    assert.deepEqual(await shot(same.ctx), { unchanged: true, path: p1 });
    assert.ok(!fs.existsSync(p2));
    assert.ok(same.calls.some((c) => c.eval?.includes("caret-color")), "mask injected");
    assert.ok(same.calls.some((c) => c.eval?.includes("remove()")), "mask removed");
    const diff = await shot(fakeCtx({ flags: { ...f, out: p3 }, data: Buffer.from("other").toString("base64") }).ctx);
    assert.equal(diff.path, p3);
    assert.ok(fs.existsSync(p3));
  } finally { delete process.env.VIDAR_EXPLORER_RUN; }
});

test("no run folder: never skips", async () => {
  delete process.env.VIDAR_EXPLORER_RUN;
  const dir = tmp(); const f = { clip: "#x" };
  await shot(fakeCtx({ flags: { ...f, out: path.join(dir, "1.png") } }).ctx);
  const r = await shot(fakeCtx({ flags: { ...f, out: path.join(dir, "2.png") } }).ctx);
  assert.equal(r.path, path.join(dir, "2.png"));
  assert.ok(fs.existsSync(path.join(dir, "2.png")));
});

const claudeOut = JSON.stringify({ type: "result", result: " A gear icon. ", usage: { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 1, cache_creation_input_tokens: 3 } });

test("look --file with a stubbed runner returns text, path and tokens", async () => {
  const dir = tmp(); const img = path.join(dir, "x.png"); fs.writeFileSync(img, "png");
  let seen;
  const spawn = (cmd, args, input) => { seen = { cmd, args, input }; return { status: 0, stdout: claudeOut, stderr: "" }; };
  const r = await runLook({ argv: ["look", "--file", img, "What is it?"], env: {}, spawn });
  assert.deepEqual(r, { answer: "A gear icon.", shot: img, tokens: { input: 2, output: 9, cacheRead: 1, cacheCreate: 3 } });
  assert.equal(seen.cmd, "claude");
  assert.ok(seen.args.includes("claude-haiku-5-5"));
  const msg = JSON.parse(seen.input).message.content;
  assert.equal(msg[0].type, "image");
  assert.match(msg[1].text, /at most two sentences[\s\S]*What is it\?/);
});

test("look cap: five per episode, the sixth is refused with exit 2", async () => {
  const dir = tmp(); const run = path.join(dir, "run"); const img = path.join(dir, "x.png"); fs.writeFileSync(img, "png");
  const env = { VIDAR_EXPLORER_RUN: run, VIDAR_EXPLORER_EPISODE: "ep1" };
  const spawn = () => ({ status: 0, stdout: claudeOut, stderr: "" });
  for (let i = 0; i < 5; i++) await runLook({ argv: ["look", "--file", img, "q"], env, spawn });
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, "state", "looks.json"), "utf8")).ep1, 5);
  const realExit = process.exit, realErr = console.error; let code, msg;
  process.exit = (c) => { code = c; throw new Error("exit"); };
  console.error = (m) => { msg = m; };
  try { await assert.rejects(runLook({ argv: ["look", "--file", img, "q"], env, spawn }), /exit/); }
  finally { process.exit = realExit; console.error = realErr; }
  assert.equal(code, 2);
  assert.equal(msg, "refused: look cap 5 reached");
  assert.equal(countLook(run, "ep2"), 1, "another episode starts fresh");
});

test("parseClaude reads a result among stream lines and reports errors", () => {
  assert.equal(parseClaude(`{"type":"system"}\n${claudeOut}\n`).answer, "A gear icon.");
  assert.throws(() => parseClaude('{"type":"system"}'), /no result/);
  assert.throws(() => parseClaude('{"type":"result","is_error":true,"result":"boom"}'), /boom/);
});
