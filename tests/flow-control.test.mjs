import test from "node:test";
import assert from "node:assert/strict";
import { STARTER_TEMPLATES } from "../src/flow/templates.ts";
import { instantiateTemplate, adaptModelsToWired } from "../src/flow/store-core.ts";
import { validateGraph } from "../src/flow/validate.ts";
import { autoLayout } from "../src/flow/layout.ts";
import { prepareFlow, checkPrepared, orderedNodes, approveSnapshot } from "../src/flow/control-core.ts";
import { flowCardRows, flowCardMatrix, flowCardDecision } from "../src/control/flow-card.ts";
import { resolveNodeGrants, modesOfGrants } from "../src/flow/permission-mode.ts";
import { readFileSync } from "node:fs";
import { flowStatusLine, waitForFlow } from "../src/flow/control-observe.ts";

const cwd = "D:\\Work";
const wiredIds = ["claude-sonnet-5", "claude-opus-5-5"];
const deps = () => ({ templates: STARTER_TEMPLATES, wiredIds: [...wiredIds], instantiateTemplate, adaptModelsToWired,
  validateGraph, autoLayout, now: () => "2026-10-18T00:00:00.000Z", newId: () => "graph-control" });
const templateRequest = (id = STARTER_TEMPLATES[0].id) => ({ action: "start", template_id: id, input: "Do the work", cwd });
const custom = () => structuredClone(STARTER_TEMPLATES[1].graph);

test("all seven starters pass the agent cap after preparation", () => {
  const counts = new Map([["tpl-brainstorm-format-review-execute", 3], ["tpl-planned-implementation", 6],
    ["tpl-diagnose-and-fix", 6]]);
  for (const template of STARTER_TEMPLATES) {
    const graph = prepareFlow(templateRequest(template.id), deps());
    assert.equal(graph.nodes.filter((n) => n.kind === "agent").length, counts.get(template.id) ?? 5, template.id);
    assert.equal(validateGraph(graph).valid, true, template.id);
    assert.equal(graph.nodes.filter((n) => n.kind === "agent").every((n) => n.addons.some((a) => a.kind === "cwd" && a.value === cwd)), true);
  }
});

test("invalid and oversized requests fail before a card", () => {
  assert.throws(() => prepareFlow(templateRequest("missing"), deps()), /bad template id/);
  assert.throws(() => prepareFlow({ ...templateRequest(), input: "x".repeat(66_000) }, deps()), /65536/);
  assert.throws(() => prepareFlow({ ...templateRequest(), extra: true }, deps()), /unknown request field/);
  const graph = custom();
  graph.nodes[1].fields = "wrong";
  assert.throws(() => prepareFlow({ action: "start", graph, cwd }, deps()), /bad nodes\[1\]\.fields: expected an array/);
  const unknownNested = custom();
  unknownNested.nodes[1].hidden = "surprise";
  assert.throws(() => prepareFlow({ action: "start", graph: unknownNested, cwd }, deps()), /unknown nodes\[1\] field "hidden" \(allowed: id, kind/);
  const oversizedNested = custom();
  oversizedNested.nodes[1].fields[0].v = "x".repeat(66_000);
  assert.throws(() => prepareFlow({ action: "start", graph: oversizedNested, cwd }, deps()), /65536/);
  const expanded = structuredClone(STARTER_TEMPLATES[0]);
  expanded.graph.nodes[1].fields.find((field) => field.k === "task").v += "x".repeat(65_000);
  assert.ok(new TextEncoder().encode(JSON.stringify(templateRequest(expanded.id))).length < 65_536);
  assert.throws(() => prepareFlow(templateRequest(expanded.id), { ...deps(), templates: [expanded] }), /snapshot exceeds 65536 bytes/);
  const duplicate = custom();
  duplicate.nodes[2].id = duplicate.nodes[1].id;
  assert.throws(() => prepareFlow({ action: "start", graph: duplicate, cwd }, deps()), /more than one node/);
  const tooMany = custom();
  tooMany.nodes.splice(1, 0, ...Array.from({ length: 4 }, (_, i) => ({ ...structuredClone(tooMany.nodes[1]), id: `extra${i}` })));
  assert.throws(() => prepareFlow({ action: "start", graph: tooMany, cwd }, deps()), /Agent Nodes must be 1-6/);
  const unwired = custom();
  unwired.nodes[1].model = "missing-model";
  assert.throws(() => prepareFlow({ action: "start", graph: unwired, cwd }, deps()), /unwired model/);
});

test("errors name the path, the key and the allowed set", () => {
  const send = (graph, extra = {}) => () => prepareFlow({ action: "start", graph, cwd, ...extra }, deps());
  assert.throws(send({ ...custom(), description: "x" }), /unknown graph field "description" \(allowed: name, nodes, edges\)/);
  const badKey = custom();
  badKey.nodes[2].fields = [{ k: "a", v: "b", extra: 1 }];
  assert.throws(send(badKey), /unknown nodes\[2\]\.fields\[0\] field "extra" \(allowed: k, v\)/);
  const badValue = custom();
  badValue.nodes[1].fields[0].k = 5;
  assert.throws(send(badValue), /bad nodes\[1\]\.fields\[0\]\.k/);
  const badEdge = custom();
  badEdge.edges[1].to.port = 5;
  assert.throws(send(badEdge), /bad edges\[1\]\.to\.port/);
  const badPos = custom();
  badPos.nodes[0].x = "left";
  assert.throws(send(badPos), /bad nodes\[0\]\.x/);
  assert.throws(() => prepareFlow(templateRequest("missing"), deps()), /bad template id "missing" \(valid: tpl-planned-implementation, tpl-brainstorm-format-review-execute, /);
});

test("the documented minimal graph parses and needs no x or y", async () => {
  const { readFileSync } = await import("node:fs");
  const doc = JSON.parse(readFileSync(new URL("./fixtures/flow-minimal-graph.json", import.meta.url), "utf8"));
  assert.equal(doc.nodes.every((n) => n.x === undefined && n.y === undefined), true);
  const graph = prepareFlow({ action: "start", graph: doc, cwd }, deps());
  assert.deepEqual(orderedNodes(graph).map((n) => n.id), ["input", "summarize", "output"]);
  assert.equal(validateGraph(graph).valid, true);
  const skill = readFileSync(new URL("../plugins/vidar-app/skills/vidar-control/SKILL.md", import.meta.url), "utf8");
  const block = /```json\r?\n([\s\S]*?)\r?\n```/.exec(skill.slice(skill.indexOf("A custom graph is")))[1];
  assert.deepEqual(JSON.parse(block), doc);
});

test("save prepares a graph with an empty Input and refuses a template or a bad graph", () => {
  const graph = custom();
  graph.nodes[0].fields.find((f) => f.k === "content").v = "";
  const saved = prepareFlow({ action: "save", graph, cwd }, deps());
  assert.equal(saved.nodes[0].fields.find((f) => f.k === "content").v, "");
  assert.throws(() => prepareFlow({ action: "start", graph, cwd }, deps()), /missing required field "content"/);
  assert.throws(() => prepareFlow({ action: "save", cwd }, deps()), /save needs a graph/);
  assert.throws(() => prepareFlow({ action: "save", template_id: "x", input: "y", cwd }, deps()), /save needs a graph/);
  const unwired = custom();
  unwired.nodes[1].model = "missing-model";
  assert.throws(() => prepareFlow({ action: "save", graph: unwired, cwd }, deps()), /unwired model/);
});

test("every prepared graph is laid out top to bottom, ignoring sent positions", () => {
  const graph = custom();
  graph.nodes[0].fields.find((f) => f.k === "content").v = "Run this";
  for (const n of graph.nodes) { n.x = 0; n.y = 0; }
  const prepared = prepareFlow({ action: "start", graph, cwd }, deps());
  const ys = orderedNodes(prepared).map((n) => n.y);
  assert.equal(new Set(ys).size, ys.length);
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b));
  const tpl = prepareFlow(templateRequest(), deps());
  const tys = orderedNodes(tpl).map((n) => n.y);
  assert.deepEqual(tys, [...tys].sort((a, b) => a - b));
  assert.equal(new Set(tys).size, tys.length);
});

test("snapshot, model adaptation, working directory and card text stay fixed", () => {
  const template = structuredClone(STARTER_TEMPLATES[1]);
  template.graph.nodes[1].fields.find((f) => f.k === "task").v += `\n${"padding\n".repeat(35)}${"z".repeat(4100)} MALICIOUS SUFFIX`;
  const source = { action: "start", template_id: template.id, input: `Input ${"x".repeat(4200)} TAIL`, cwd };
  const models = [...wiredIds];
  const graph = prepareFlow(source, { ...deps(), wiredIds: models, templates: [template] });
  source.input = "mutated";
  template.graph.nodes[1].fields[0].v = "mutated";
  models[0] = "changed";
  const rows = flowCardRows(graph, "Caller", orderedNodes);
  assert.match(rows.find(([k]) => k === "Input")[1], /TAIL$/);
  assert.match(rows.find(([k]) => k === "Task")[1], /MALICIOUS SUFFIX$/);
  assert.equal(Object.isFrozen(graph.nodes[1].fields[0]), true);
  assert.equal(graph.nodes[1].model, "claude-sonnet-5");
  assert.throws(() => { graph.nodes[1].fields[0].v = "changed"; }, TypeError);
  checkPrepared(graph, validateGraph);
  const explicit = custom();
  explicit.nodes[0].fields.find((f) => f.k === "content").v = "Run this";
  explicit.nodes[1].addons = [{ kind: "cwd", label: "Working Directory", value: "E:\\Other" }];
  const prepared = prepareFlow({ action: "start", graph: explicit, cwd }, deps());
  assert.equal(prepared.nodes[1].addons.find((a) => a.kind === "cwd").value, "E:\\Other");
  const dotted = custom();
  dotted.nodes[0].fields.find((f) => f.k === "content").v = "Run this";
  dotted.nodes[1].addons = [{ kind: "cwd", label: "Working Directory", value: "E:\\Base\\Sub\\..\\Target\\." }];
  const resolved = prepareFlow({ action: "start", graph: dotted, cwd: "D:\\Root\\.\\Work" }, deps());
  assert.equal(resolved.nodes[1].addons.find((a) => a.kind === "cwd").value, "E:\\Base\\Target");
  assert.equal(resolved.nodes[2].addons.find((a) => a.kind === "cwd").value, "D:\\Root\\Work");
  explicit.nodes[1].fields[0].v = "mutated source JSON";
  assert.notEqual(prepared.nodes[1].fields[0].v, "mutated source JSON");
});

test("denial and expiry never call approval; save failure has a failed verdict", async () => {
  let approvals = 0;
  const approve = async () => { approvals++; throw new Error("save disk full"); };
  const denied = await flowCardDecision("graph-1", { approved: false, shown: true, comment: "No" }, false, false, false, approve);
  assert.deepEqual(denied, { ok: false, line: "denied No", verdict: "denied" });
  const expired = await flowCardDecision("graph-1", { approved: true, shown: true, comment: "" }, false, true, false, approve);
  assert.deepEqual(expired, { ok: false, line: "err expired", verdict: "failed" });
  assert.equal(approvals, 0);
  assert.deepEqual(await flowCardDecision("graph-1", { approved: true, shown: true, comment: "" }, false, false, false, approve),
    { ok: false, line: "err save disk full", verdict: "failed" });
  assert.equal(approvals, 1);
});

test("status follows edges and includes output paths", () => {
  const graph = prepareFlow(templateRequest(STARTER_TEMPLATES[1].id), deps());
  const run = { id: "run-1", graphId: graph.id, graphSnapshot: graph, status: "success", nodes: {} };
  const line = JSON.parse(flowStatusLine(run, "D:\\Flow", orderedNodes));
  assert.deepEqual(line.nodes.map((n) => n.id), orderedNodes(graph).map((n) => n.id));
  assert.equal(line.nodes[1].output_file, `D:\\Flow\\runs\\run-1\\${line.nodes[1].id}.md`);
});

test("wait subscribes before check, supports two waiters, timeout and requester gone", async () => {
  let run = { id: "run-1", status: "running" };
  const listeners = new Set();
  const subscribe = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
  const get = () => run;
  const first = waitForFlow(run.id, 10_000, get, subscribe);
  const second = waitForFlow(run.id, 10_000, get, subscribe);
  assert.equal(listeners.size, 2);
  run = { ...run, status: "success" };
  for (const listener of [...listeners]) listener();
  assert.equal((await first).status, "success");
  assert.equal((await second).status, "success");
  assert.equal(listeners.size, 0);
  const between = waitForFlow(run.id, 10_000, get, (cb) => { cb(); return () => {}; });
  assert.equal((await between).status, "success");
  let scheduled = 0;
  let listenersAdded = 0;
  const signal = new AbortController().signal;
  const add = signal.addEventListener.bind(signal);
  signal.addEventListener = (...args) => { listenersAdded++; return add(...args); };
  const immediate = waitForFlow(run.id, 10_000, get, (cb) => { cb(); return () => {}; }, signal,
    { setTimeout: () => { scheduled++; return 1; }, clearTimeout: () => {} });
  assert.equal((await immediate).status, "success");
  assert.equal(scheduled, 0);
  assert.equal(listenersAdded, 0);
  run = { ...run, status: "running" };
  const controller = new AbortController();
  const gone = waitForFlow(run.id, 10_000, get, subscribe, controller.signal);
  controller.abort();
  assert.equal(await gone, "gone");
  assert.equal(listeners.size, 0);
  assert.equal(await waitForFlow(run.id, 1, get, subscribe), "timeout");
  assert.equal(listeners.size, 0);
});

test("approval commits the exact snapshot before start; failed save retries without a run", async () => {
  const graph = prepareFlow(templateRequest(), deps());
  let busy = false;
  let writes = 0;
  let runs = 0;
  const hooks = { validateGraph, reserve: () => {
    if (busy) throw new Error("flow busy");
    busy = true;
    return () => { busy = false; };
  }, commit: async (value) => {
    assert.equal(value, graph);
    writes++;
    if (writes === 1) throw new Error("disk full");
  }, start: (value) => { assert.equal(value, graph); runs++; return "run-1"; } };
  await assert.rejects(approveSnapshot(graph, hooks), /save disk full/);
  assert.equal(runs, 0);
  assert.equal(busy, false);
  assert.equal(await approveSnapshot(graph, hooks), "run-1");
  assert.equal(writes, 2);
  assert.equal(runs, 1);
  busy = true;
  await assert.rejects(approveSnapshot(graph, hooks), /flow busy/);
  assert.equal(writes, 2);
});

test("an agent graph with a node vault parses; an allowlist addon is dropped", () => {
  const graph = custom();
  graph.nodes[0].fields.find((f) => f.k === "content").v = "Run this";
  graph.nodes[1].vault = "reviewer";
  graph.nodes[1].addons = [
    { kind: "permission-allowlist", label: "Allowlist", value: "Bash" },
    { kind: "retries", label: "Retries", value: "2" },
  ];
  const prepared = prepareFlow({ action: "start", graph, cwd }, deps());
  assert.equal(prepared.nodes[1].vault, "reviewer");
  assert.equal(prepared.nodes[1].addons.some((a) => a.kind === "permission-allowlist"), false);
  assert.equal(prepared.nodes[1].addons.find((a) => a.kind === "retries").value, "2");
  const bad = custom();
  bad.nodes[1].vault = 7;
  assert.throws(() => prepareFlow({ action: "start", graph: bad, cwd }, deps()), /bad nodes\[1\]\.vault: expected a string/);
});

test("grants ask with the node's vault and agent; the card names the vault and its allows", async () => {
  const graph = custom();
  graph.nodes[0].fields.find((f) => f.k === "content").v = "Run this";
  graph.nodes[1].vault = "reviewer";
  const prepared = prepareFlow({ action: "start", graph, cwd }, deps());
  const agents = orderedNodes(prepared).filter((n) => n.kind === "agent");
  let asked;
  const grants = await resolveNodeGrants(prepared, async (nodes) => {
    asked = nodes;
    return nodes.map((n) => ({ node: n.node, vault: n.vault ?? "stock-claude", mode: "auto", allow: ["Read", "Glob"], hash: `h-${n.node}` }));
  }, () => "claude");
  assert.equal(asked.length, agents.length);
  assert.ok(asked.every((n) => n.agent === "claude" && typeof n.model === "string"));
  assert.equal(asked.find((n) => n.node === agents[0].id).vault, "reviewer");
  assert.equal("vault" in asked.find((n) => n.node !== agents[0].id), false);
  assert.equal(grants[agents[0].id].hash, `h-${agents[0].id}`);
  const rows = flowCardRows(prepared, "Caller", orderedNodes, modesOfGrants(grants), grants);
  assert.equal(rows.find(([k]) => k === "Vault")[1], "reviewer");
  assert.equal(rows.find(([k]) => k === "Allows")[1], "Read, Glob");
  assert.equal(rows.find(([k]) => k === "Permission Mode")[1], "Auto");
  assert.equal(rows.some(([k]) => k === "Allowlist"), false);
  const fields = flowCardMatrix(prepared, "Caller", orderedNodes, modesOfGrants(grants), grants).fields.map((f) => f.label);
  assert.ok(fields.includes("Vault") && fields.includes("Allows") && !fields.includes("Allowlist"));
});

test("flow_run_node carries vault and vaultHash from the grant, and nothing of the old allowlist", () => {
  const engine = readFileSync(new URL("../src/flow/engine.ts", import.meta.url), "utf8");
  assert.match(engine, /vault: grant\.vault,\s*vaultHash: grant\.hash/);
  assert.match(engine, /invoke\("flow_node_permissions", \{ nodes \}\)/);
  assert.doesNotMatch(engine, /toolAllowlist|permission-allowlist|flow_permission_modes/);
});
