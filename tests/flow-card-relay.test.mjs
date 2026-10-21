// The Run Flow approval is one card on two surfaces: the ask modal and a Relay item (kind "card").
// The first answer wins and the other side clears; Relay answers through askgate's answerAsk and
// never starts the flow itself (src/control/flow.ts stays the single decision path).
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
const store = await import("../src/relay/store.ts");
const { createCardForm } = await import("../src/relay/card-view.ts");

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
    label: () => "Caller", problem: () => null, live: new Set(), settle: () => false,
  });
  return results;
}
const modal = () => document.getElementById("ask-modal");

test("the card posts to Relay with the modal's rows and the title Run Flow", async () => {
  const results = start("101");
  await tick(20);
  const [item] = flowItems();
  assert.equal(item.title, "Run Flow");
  assert.equal(item.view.type, "card");
  // the modal is the Node Matrix: nodes as columns, icon labels with tooltips, no Order text row
  assert.equal(modal().querySelectorAll(".ask-row").length, 0);
  const grid = (root) => [...root.querySelectorAll("tbody tr")].map((r) => [r.querySelector(".nm-ico").title, [...r.querySelectorAll("td:not(:first-child)")].map((c) => c.textContent)]);
  const shown = grid(modal());
  assert.ok(modal().querySelector(".nm .nm-scroll"));
  assert.ok(item.view.matrix.nodes.length >= 1);
  assert.equal(modal().querySelectorAll("thead th").length, item.view.matrix.nodes.length + 1, "one column per agent node");
  const mode = shown.find(([k]) => k === "Permission Mode");
  assert.deepEqual(mode[1], ["Auto"], "the card states the resolved mode, once when every node shares it");
  assert.equal(modal().textContent.includes("Order"), false);
  assert.ok(item.view.rows.some(([k]) => k === "Task"), "the flat rows still feed the drive surface");
  const host = document.createElement("div");
  createCardForm(host, item);
  assert.deepEqual(grid(host), shown, "Relay shows the modal's matrix");
  assert.deepEqual([...host.querySelectorAll("button")].map((b) => b.textContent), ["Approve", "Deny"]);
  await item.resolve({ verdict: "deny", comment: "" });
  await tick(20);
  assert.equal(results[0].verdict, "denied");
});

test("Relay approve resolves the gate, starts through the decision path and clears both sides", async () => {
  globalThis.__approvals = 0;
  const results = start("102");
  await tick(20);
  const [item] = flowItems();
  assert.equal(modal().classList.contains("hidden"), false);
  await item.resolve({ verdict: "approve", comment: "" });
  await tick(20);
  assert.equal(globalThis.__approvals, 1);
  assert.equal(results.length, 1);
  assert.match(results[0].line, /^started graph=\S+ run=run-1$/);
  assert.equal(results[0].verdict, "approved");
  assert.equal(modal().classList.contains("hidden"), true, "the modal tore down");
  assert.equal(flowItems().length, 0);
});

test("a modal answer removes the Relay item, and a late Relay answer is a no-op", async () => {
  globalThis.__approvals = 0;
  const results = start("103");
  await tick(20);
  const [item] = flowItems();
  modal().querySelector(".ask-deny").click();
  await tick(20);
  assert.equal(flowItems().length, 0);
  assert.equal(results[0].verdict, "denied");
  await item.resolve({ verdict: "approve", comment: "" });
  await tick(20);
  assert.equal(globalThis.__approvals, 0);
  assert.equal(results.length, 1);
});

test("expiry removes the Relay item", async () => {
  const results = start("104", 60);
  await tick(20);
  assert.equal(flowItems().length, 1);
  await tick(120);
  assert.equal(flowItems().length, 0);
  assert.deepEqual(results, [{ ok: false, line: "err expired", verdict: undefined }]);
  assert.equal(modal().classList.contains("hidden"), true);
});
