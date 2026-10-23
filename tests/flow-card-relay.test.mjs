// The Run Flow approval is one approval record (origin ctl-flow) shown as a Relay item (kind "card").
// Relay answers the record; the registry settles it once, and src/control/flow.ts starts the flow
// only through the decision path on that one settle.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "flow/control-start": `export async function prepareControlFlow() { return globalThis.__snapshot; }
      export async function saveControlFlow() { return "saved graph=stub"; }
      export async function approveControlFlow() { globalThis.__approvals++; return "run-1"; }`,
    "flow/runs-store": "export const getRun = () => null; export const subscribeRuns = () => () => {}; export async function initRunsStore() {}",
    "flow/control-observe": "export const flowStatusLine = () => ''; export const waitForFlow = async () => 'timeout';",
    "flow/file-storage": "export async function initFlowStorage() {}",
    "flow/engine": `export const heldRunIds = () => new Set();
      export const resolveRunModes = async (g) => Object.fromEntries(g.nodes.filter((n) => n.kind === "agent").map((n) => [n.id, "auto"]));`,
    "control/registry": "export const driveSnapshot = () => ({ tabs: [] }); export const requesterTabId = () => null;",
  },
});
const { STARTER_TEMPLATES } = await import("../src/flow/templates.ts");
const { instantiateTemplate, adaptModelsToWired } = await import("../src/flow/store-core.ts");
const { validateGraph } = await import("../src/flow/validate.ts");
const { autoLayout } = await import("../src/flow/layout.ts");
const { prepareFlow } = await import("../src/flow/control-core.ts");
const { handleFlowCard } = await import("../src/control/flow.ts");
const { startApprovalSource } = await import("../src/relay/source-approvals.ts");
const { liveApprovals } = await import("../src/asks/approvals.ts");
const store = await import("../src/relay/store.ts");
const { createCardForm } = await import("../src/relay/card-view.ts");

startApprovalSource();
globalThis.__snapshot = prepareFlow({ action: "start", template_id: STARTER_TEMPLATES[1].id, input: "Do the work", cwd: "D:\\Work" }, {
  templates: STARTER_TEMPLATES, wiredIds: ["claude-sonnet-5", "claude-opus-5-5"], instantiateTemplate, adaptModelsToWired,
  validateGraph, autoLayout, now: () => "2026-10-18T00:00:00.000Z", newId: () => "graph-card",
});
globalThis.__approvals = 0;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const flowItems = () => store.items().filter((i) => i.kind === "card");
function start(cardId, ttlMs = 60_000) {
  const results = [];
  handleFlowCard({ id: `ctl-${cardId}`, cardId, details: {}, requester: {}, claimedAtMs: Date.now(), expiresAtMs: Date.now() + ttlMs }, {
    cardResult: (id, card, ok, line, verdict) => results.push({ ok, line, verdict }),
    label: () => "Caller", problem: () => null,
  });
  return results;
}

test("the card posts to Relay as a Run Flow record with the Node Matrix", async () => {
  const results = start("101");
  await tick(20);
  const [item] = flowItems();
  assert.equal(item.title, "Run Flow");
  assert.equal(item.view.type, "card");
  assert.equal(liveApprovals()[0].record.origin, "ctl-flow");
  assert.ok(item.view.matrix.nodes.length >= 1);
  assert.ok(item.view.rows.some(([k]) => k === "Task"), "the flat rows still feed the drive surface");
  const host = document.createElement("div");
  createCardForm(host, item);
  assert.equal(host.querySelectorAll("thead th").length, item.view.matrix.nodes.length + 1, "one column per agent node");
  // The cells shown are the ones the card payload gives: one per node per field, each non-empty value drawn.
  const { nodes, fields } = item.view.matrix;
  const shown = fields.filter((f) => f.cells.some((c) => c !== ""));
  assert.ok(shown.length >= 1, "the matrix carries at least one filled field");
  for (const f of fields) assert.equal(f.cells.length, nodes.length, "a cell per node");
  const hostText = host.textContent;
  for (const f of shown) for (const c of f.cells) if (c !== "") assert.ok(hostText.includes(c), `cell "${c}" is drawn`);
  assert.deepEqual([...host.querySelectorAll("button")].map((b) => b.textContent), ["Approve", "Deny"]);
  await item.resolve({ verdict: "deny", comment: "" });
  await tick(20);
  assert.equal(results[0].verdict, "denied");
});

test("Relay approve starts the flow once and the item clears", async () => {
  globalThis.__approvals = 0;
  const results = start("102");
  await tick(20);
  const [item] = flowItems();
  await item.resolve({ verdict: "approve", comment: "" });
  await tick(20);
  assert.equal(globalThis.__approvals, 1);
  assert.equal(results.length, 1);
  assert.match(results[0].line, /^started graph=\S+ run=run-1$/);
  assert.equal(results[0].verdict, "approved");
  assert.equal(flowItems().length, 0);
  await assert.rejects(item.resolve({ verdict: "approve", comment: "" }), /Already Answered/);
  await tick(20);
  assert.equal(globalThis.__approvals, 1, "a late second answer starts nothing");
  assert.equal(results.length, 1);
});

test("a Relay deny carries its comment and starts nothing", async () => {
  globalThis.__approvals = 0;
  const results = start("103");
  await tick(20);
  await flowItems()[0].resolve({ verdict: "deny", comment: "not now" });
  await tick(20);
  assert.equal(globalThis.__approvals, 0);
  assert.deepEqual(results, [{ ok: false, line: "denied not now", verdict: "denied" }]);
  assert.equal(flowItems().length, 0);
});

test("expiry removes the Relay item and replies err expired once", async () => {
  const results = start("104", 60);
  await tick(20);
  assert.equal(flowItems().length, 1);
  await tick(120);
  assert.equal(flowItems().length, 0);
  assert.deepEqual(results, [{ ok: false, line: "err expired", verdict: undefined }]);
});
