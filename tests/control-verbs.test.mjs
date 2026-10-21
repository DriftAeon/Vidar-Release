// tests\control-verbs.test.mjs — build() payloads shared by the CLI and the MCP server
// (tools\control\verbs.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, UsageError } from "../tools/control/verbs.mjs";
import { makeCall } from "../tools/mcp/vidar-drive/tools.mjs";

test("ask --pending builds the pend verb without a placeholder", () => {
  const built = build("ask", { question: "Which?", choices: ["a", "b"], pending: true });
  assert.equal(built.verb, "pend");
  assert.deepEqual(built.payload, { question: "Which?", choices: ["a", "b"] });
  assert.equal("placeholder" in built.payload, false);
  assert.equal(build("ask", { question: "Q" }).verb, undefined);
});

test("MCP ask with pending sends the built verb", async () => {
  const sent = [];
  const call = makeCall(async (verb, payload) => { sent.push({ verb, payload }); return { ok: true, line: "ok pending abcd1234" }; });
  const res = await call("ask", { question: "Which?", choices: ["a"], pending: true });
  assert.equal(sent[0].verb, "pend");
  assert.deepEqual(sent[0].payload, { question: "Which?", choices: ["a"] });
  assert.equal(res.content[0].text, "ok pending abcd1234");
});

test("unpend builds an optional-id payload and MCP sends it", async () => {
  assert.deepEqual(build("unpend", {}), { payload: {} });
  assert.deepEqual(build("unpend", { id: "0123abcd" }).payload, { id: "0123abcd" });
  assert.throws(() => build("unpend", { id: "nope" }), /hex/);
  const sent = [];
  const call = makeCall(async (verb, payload) => { sent.push({ verb, payload }); return { ok: true, line: "ok withdrew 1" }; });
  const res = await call("unpend", { id: "0123abcd" });
  assert.equal(sent[0].verb, "unpend");
  assert.deepEqual(sent[0].payload, { id: "0123abcd" });
  assert.equal(res.content[0].text, "ok withdrew 1");
});

test("ask details pair with choices and are validated", () => {
  const built = build("ask", { question: "Q", choices: ["a", "b"], details: ["first", ""], pending: true });
  assert.deepEqual(built.payload, { question: "Q", choices: ["a", "b"], details: ["first", ""] });
  assert.deepEqual(build("ask", { question: "Q", choices: ["a", "b"], details: ["only a"] }).payload.details, ["only a"]);
  assert.equal("details" in build("ask", { question: "Q", choices: ["a"] }).payload, false, "old shape carries no details");
  assert.throws(() => build("ask", { question: "Q", details: ["x"] }), /needs --choice/);
  assert.throws(() => build("ask", { question: "Q", choices: ["a"], details: ["x", "y"] }), /more --detail/);
  assert.throws(() => build("ask", { question: "Q", choices: ["a"], details: ["x".repeat(121)] }), /120/);
  assert.throws(() => build("ask", { question: "Q", choices: ["a"], details: ["café"] }), /printable ASCII/);
  assert.equal(build("ask", { question: "Q", choices: ["a"], details: ["x".repeat(120)] }).payload.details[0].length, 120);
});

function withBrief(name, body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "vidar-verbs-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("spawn --brief strips the BOM, sends no title and shows the path", () => {
  withBrief("brief.md", "﻿# Title\n\nbody\n", (path) => {
    const { payload } = build("spawn", { agent: "claude", model: "opus", brief: path });
    assert.equal(payload.title, undefined);
    assert.equal(payload.text, "# Title\n\nbody\n");
    assert.equal(payload.brief, path);
  });
});

test("spawn omits a non-ASCII brief path from the payload", () => {
  withBrief("brief-é.md", "# T\n", (path) => {
    const { payload } = build("spawn", { agent: "claude", model: "opus", brief: path });
    assert.equal(payload.brief, undefined);
  });
});

test("spawn without a model is a usage error", () => {
  assert.throws(() => build("spawn", { agent: "claude", text: "hi" }), /--model is required/);
});

test("spawn carries --effort in the payload only when given", () => {
  const { payload } = build("spawn", { agent: "claude", model: "opus", effort: "xhigh", text: "hi" });
  assert.equal(payload.effort, "xhigh");
  const bare = build("spawn", { agent: "claude", model: "opus", text: "hi" }).payload;
  assert.equal(Object.hasOwn(bare, "effort"), false);
});

test("spawn with an unknown effort is a usage error", () => {
  assert.throws(() => build("spawn", { agent: "claude", model: "opus", effort: "bogus", text: "hi" }), /--effort must be one of/);
});

test("spawn cwd defaults to the caller's process.cwd()", () => {
  const { payload } = build("spawn", { agent: "claude", model: "opus", text: "hi" });
  assert.equal(payload.cwd, process.cwd());
});

test("spawn --cwd wins over the caller's cwd", () => {
  const { payload } = build("spawn", { agent: "claude", model: "opus", cwd: "D:\\elsewhere", text: "hi" });
  assert.equal(payload.cwd, "D:\\elsewhere");
});

test("spawn sends a title only when --title was given", () => {
  const short = build("spawn", { agent: "claude", model: "opus", text: "\nFix the cwd bug\nmore" }).payload;
  assert.equal(short.title, undefined);
  const explicit = build("spawn", { agent: "claude", model: "opus", title: "Mine", text: "hi" }).payload;
  assert.equal(explicit.title, "Mine");
});

test("spawn without a brief or text is a usage error", () => {
  assert.throws(() => build("spawn", { agent: "claude", model: "opus" }), /--brief or --text is required/);
});

test("wait clamps timeoutS to 3600 s and adds the bus grace", () => {
  const { payload, timeoutMs } = build("wait", { tab: "t", timeoutS: 99999 });
  assert.equal(payload.timeout_ms, 3_600_000);
  assert.equal(timeoutMs, 3_615_000);
});

test("flow start reads local files and bounds the request", () => {
  withBrief("input.md", "A task", (path) => {
    const built = build("flow", { action: "start", template_id: "tpl", input_file: path, cwd: "D:\\Work" });
    assert.equal(built.payload.input, "A task");
    assert.equal(built.payload.cwd, "D:\\Work");
    assert.equal(built.timeoutMs, 300_000);
  });
  withBrief("graph.json", '{"name":"Custom","nodes":[],"edges":[]}', (path) => {
    assert.equal(build("flow", { action: "start", graph_path: path }).payload.graph.name, "Custom");
  });
  withBrief("large-input.md", "x".repeat(65_537), (path) => {
    assert.throws(() => build("flow", { action: "start", template_id: "tpl", input_file: path }), /--input-file exceeds 65536 bytes/);
  });
  withBrief("large-graph.json", "x".repeat(65_537), (path) => {
    assert.throws(() => build("flow", { action: "start", graph_path: path }), /--graph exceeds 65536 bytes/);
  });
  assert.throws(() => build("flow", { action: "start", template_id: "x", input: "y".repeat(66_000) }), /65536/);
  assert.throws(() => build("flow", { action: "start", template_id: "x", input: "y", graph: {} }), /--template and --graph are exclusive/);
  assert.throws(() => build("flow", { action: "start" }), /flow start needs --template <id> or --graph <file>/);
  assert.throws(() => build("flow", { action: "start", template_id: "brainstorm" }), /--template brainstorm needs --input or --input-file/);
});

test("flow start fills the single Input node of a custom graph", () => {
  const node = (id, kind, fields) => ({ id, kind, title: id, ...(fields === undefined ? {} : { fields }), inputs: [], outputs: [] });
  const graphWith = (fields) => ({ name: "G", nodes: [node("in", "input", fields), node("out", "output")], edges: [] });
  const start = (graph, input = "Do it") => build("flow", { action: "start", graph, input });
  const content = (built) => built.payload.graph.nodes[0].fields.filter((f) => f.k === "content");

  const missing = graphWith([{ k: "label", v: "x" }]);
  const built = start(missing);
  assert.deepEqual(content(built), [{ k: "content", v: "Do it" }]);
  assert.equal("input" in built.payload, false);
  assert.equal(missing.nodes[0].fields.length, 1, "caller graph is not mutated");
  assert.deepEqual(content(start(graphWith(undefined))), [{ k: "content", v: "Do it" }]);
  assert.deepEqual(content(start(graphWith([{ k: "content", v: "" }]))), [{ k: "content", v: "Do it" }]);
  assert.deepEqual(content(start(graphWith([{ k: "content", v: "Do it" }]))), [{ k: "content", v: "Do it" }]);
  assert.throws(() => start(graphWith([{ k: "content", v: "Other" }])), /already has content; send input or content, not both/);
  assert.throws(() => start({ name: "G", nodes: [node("out", "output")], edges: [] }), /exactly one Input node in graph \(found 0\)/);
  assert.throws(() => start({ name: "G", nodes: [node("a", "input"), node("b", "input")], edges: [] }), /exactly one Input node in graph \(found 2\)/);
  assert.throws(() => start({}), UsageError);
  assert.throws(() => start(graphWith([]), ""), /input must not be empty/);
});

test("flow save routes to flow-save with the graph and no input", () => {
  const graph = { name: "G", nodes: [], edges: [] };
  const built = build("flow", { action: "save", graph, cwd: "D:\\Work" });
  assert.equal(built.verb, "flow-save");
  assert.deepEqual(built.payload, { action: "save", graph, cwd: "D:\\Work" });
  assert.throws(() => build("flow", { action: "save" }), /flow save needs --graph/);
  assert.throws(() => build("flow", { action: "save", graph, input: "x" }), /flow save takes --graph only/);
  assert.throws(() => build("flow", { action: "save", template_id: "t", graph }), /flow save takes --graph only/);
});

test("flow status and wait use observe routes", () => {
  assert.deepEqual(build("flow", { action: "status", run_id: "run-1" }), { verb: "flow-status", payload: { run_id: "run-1" } });
  const wait = build("flow", { action: "wait", run_id: "run-1", timeoutS: 5000 });
  assert.equal(wait.verb, "flow-wait");
  assert.equal(wait.payload.timeout_ms, 3_600_000);
  assert.equal(wait.timeoutMs, 3_615_000);
});
