// tools\mcp\vidar-drive\server.test.mjs — stdio contract, trust boundary and concurrent dispatch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { serve } from "./rpc.mjs";
import { makeCall } from "./tools.mjs";
import { handlers } from "./server.mjs";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const line = (o) => `${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`;

test("outside a Vidar tab: three replies, version echoed, 10 tools, state is exit 4", async () => {
  const env = { ...process.env };
  delete env.VIDAR_CTL_TOKEN;
  delete env.FALCON_SESSION;
  delete env.VIDAR_CTL_SECRET;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d) => { out += d; });
  child.stdin.end(
    line({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) +
    line({ method: "notifications/initialized" }) +
    line({ id: 2, method: "tools/list" }) +
    line({ id: 3, method: "tools/call", params: { name: "state", arguments: {} } }),
  );
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0);
  const replies = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)); // every line valid JSON
  assert.equal(replies.length, 3);
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.equal(byId[1].result.protocolVersion, "2025-06-18");
  assert.equal(byId[2].result.tools.length, 10);
  assert.equal(byId[3].result.isError, true);
  assert.match(byId[3].result.content[0].text, /^exit 4:/);
});

test("MCP flow uses launch cwd and routes observation without a card", async () => {
  const sent = [];
  const call = makeCall(async (verb, payload) => { sent.push({ verb, payload }); return { ok: true, line: "ok" }; }, "D:\\Launch");
  await call("flow", { action: "start", template_id: "tpl", input: "Do it" });
  assert.equal(sent[0].verb, "flow");
  assert.equal(sent[0].payload.cwd, "D:\\Launch");
  await call("flow", { action: "start", template_id: "tpl", input: "Do it", cwd: "E:\\Other" });
  assert.equal(sent[1].payload.cwd, "E:\\Other");
  await call("flow", { action: "status", run_id: "run-1" });
  assert.equal(sent[2].verb, "flow-status");
  assert.equal(Object.hasOwn(sent[2].payload, "cwd"), false);
});

test("MCP flow start with graph and input sends the filled graph only", async () => {
  const sent = [];
  const call = makeCall(async (verb, payload) => { sent.push({ verb, payload }); return { ok: true, line: "ok" }; }, "D:\\Launch");
  const graph = { name: "G", nodes: [{ id: "in", kind: "input", title: "In", fields: [], inputs: [], outputs: [] }], edges: [] };
  await call("flow", { action: "start", graph, input: "Do it" });
  assert.deepEqual(sent[0].payload.graph.nodes[0].fields.map((f) => f.v), ["Do it"]);
  assert.equal(Object.hasOwn(sent[0].payload, "input"), false);
});

test("MCP spawn without cwd carries the launch cwd", async () => {
  let seen;
  const fake = async (verb, payload) => { seen = { verb, payload }; return { ok: true, line: "spawned t1 prompted" }; };
  const launch = process.platform === "win32" ? "C:\\Work\\proj" : "/work/proj";
  const call = makeCall(fake, launch);
  await call("spawn", { agent: "claude", model: "m", text: "hi" });
  assert.equal(seen.verb, "spawn");
  assert.equal(seen.payload.cwd, launch);
  await call("spawn", { agent: "claude", model: "m", text: "hi", cwd: "D:\\x" });
  assert.equal(seen.payload.cwd, "D:\\x");
});

test("a call sent while another is pending is answered first", async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const fake = (verb) => (verb === "wait" ? slow : Promise.resolve({ ok: true, line: "active=a tabs=1" }));
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serve({ input, output, handlers: handlers(makeCall(fake)) });
  const replies = createInterface({ input: output })[Symbol.asyncIterator]();

  input.write(line({ id: 1, method: "tools/call", params: { name: "wait", arguments: { tab: "t" } } }));
  input.write(line({ id: 2, method: "tools/call", params: { name: "state", arguments: {} } }));
  const first = JSON.parse((await replies.next()).value);
  assert.equal(first.id, 2);

  release({ ok: true, line: "done t report=-" });
  const second = JSON.parse((await replies.next()).value);
  assert.equal(second.id, 1);
  input.end();
  await done;
});

test("isMain matches the module path with and without the verbatim prefix", async () => {
  const { isMain, normPath } = await import("./server.mjs");
  const url = import.meta.url.replace("server.test.mjs", "server.mjs");
  const plain = fileURLToPath(url);
  assert.equal(isMain(plain, url), true);
  assert.equal(isMain("\\\\?\\" + plain, url), true);
  assert.equal(isMain(plain.toUpperCase(), url, "win32"), true);
  assert.equal(isMain(plain + ".other", url), false);
  assert.equal(isMain(undefined, url), false);
  assert.equal(normPath("\\\\?\\UNC\\srv\\share\\x", "win32"), "\\\\srv\\share\\x");
});
