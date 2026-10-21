// Flow tool approvals reach Relay: one card per pending request across every run (a bus-started run
// is never S.activeRunId), each bound to its own permission id, a stale card sends and records nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

globalThis.__log = [];
globalThis.__subs = [];
setupDom({
  stubs: {
    "flow/engine": `export function initEngine() { globalThis.__log.push("initEngine"); }
      export function recordDenial(r, n, a) { globalThis.__log.push("recordDenial:" + r + ":" + n); }
      export function endDeniedNode(r, n) { globalThis.__log.push("endDeniedNode:" + r + ":" + n); }`,
    "flow/runner-adapter": "export function onFlowNodeEvent(fn) { globalThis.__subs.push(fn); return () => {}; }",
    "flow/runs-store": "export const getRun = (id) => globalThis.__runs[id] ?? null;",
    "flow/approvals-panel": "export function openApprovals() {} export function paintApprovalsPanel() {}",
    "flow/edges": "export const edgeEls = () => null;",
  },
  answers: {
    flow_answer_permission: (args) => { globalThis.__log.push("invoke:" + args.permissionId + ":" + args.allow); return null; },
  },
});
const { S, notifyPendingApprovalsChanged } = await import("../src/flow/state.ts");
const store = await import("../src/relay/store.ts");
const { startFlowApprovalRelay } = await import("../src/flow/approvals-relay.ts");
const { createCardForm } = await import("../src/relay/card-view.ts");

globalThis.__runs = {
  "run-a": { id: "run-a", graphSnapshot: { name: "Review Flow", nodes: [{ id: "n1", title: "Reviewer" }, { id: "n2", title: "Fixer" }] } },
};
S.activeRunId = "run-other"; // the run under approval is not the canvas's shown run

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const cards = () => store.items().filter((i) => i.source === "flow-approvals");
function add(id, nodeId = "n1", command = "git status") {
  S.pendingApprovals.set(id, { runId: "run-a", nodeId, attempt: 1, request: { id, toolUseId: null, tool: "Bash", input: { command }, suggestions: [] } });
  notifyPendingApprovalsChanged();
}
function reset() {
  S.pendingApprovals.clear();
  notifyPendingApprovalsChanged();
  globalThis.__log.length = 0;
}
startFlowApprovalRelay();

test("initEngine runs before the relay subscribes", () => {
  assert.equal(globalThis.__log[0], "initEngine");
  assert.equal(globalThis.__subs.length, 1);
});

test("a 64 KiB, 300-line command reaches the Relay card row and the block whole", () => {
  reset();
  const body = Array.from({ length: 300 }, (_, i) => `${i}${"y".repeat(200)}`).join("\n");
  const command = body + "z".repeat(65536 - body.length);
  assert.equal(command.split("\n").length, 300);
  add("perm-big", "n1", command);
  const [item] = cards();
  assert.equal(item.view.rows[3][1], command);
  const host = document.createElement("div");
  createCardForm(host, item);
  assert.equal(host.querySelector(".nm-pre").textContent, command);
  reset();
});

test("a pending approval from a non-active run is one Relay card and Approve answers its id", async () => {
  reset();
  add("perm-1");
  const [item] = cards();
  assert.equal(cards().length, 1);
  assert.equal(item.id, "flow-approval:perm-1");
  assert.equal(item.kind, "card");
  assert.equal(item.title, "Tool Approval");
  assert.deepEqual(item.view.rows, [["Flow", "Review Flow"], ["Node", "Reviewer"], ["Tool", "Bash"], ["Request", "git status"]]);
  const host = document.createElement("div");
  createCardForm(host, item);
  assert.deepEqual([...host.querySelectorAll("button")].map((b) => b.textContent), ["Approve", "Deny"]);
  assert.deepEqual([...host.querySelectorAll(".nm-facts .nm-ico")].map((i) => i.title), ["Flow", "Node", "Tool"]);
  assert.deepEqual([...host.querySelectorAll(".nm-facts .nm-v")].map((v) => v.textContent), ["Review Flow", "Reviewer", "Bash"]);
  assert.equal(host.querySelector(".nm-pre").textContent, "git status");
  await item.resolve({ verdict: "approve", comment: "" });
  await tick(5);
  assert.deepEqual(globalThis.__log, ["invoke:perm-1:true"]);
  assert.equal(cards().length, 0);
});

test("two pending approvals: answering the second card answers the second id", async () => {
  reset();
  add("perm-a");
  add("perm-b", "n2", "ls");
  // the store orders newest-first by sinceMs, which ties when both adds land in one millisecond
  assert.deepEqual(cards().map((c) => c.id).sort(), ["flow-approval:perm-a", "flow-approval:perm-b"]);
  await cards().find((c) => c.id === "flow-approval:perm-b").resolve({ verdict: "approve", comment: "" });
  await tick(5);
  assert.deepEqual(globalThis.__log, ["invoke:perm-b:true"]);
  assert.deepEqual(cards().map((c) => c.id), ["flow-approval:perm-a"]);
});

test("deny records the denial before the invoke and ends the node after", async () => {
  reset();
  add("perm-d");
  await cards()[0].resolve({ verdict: "deny", comment: "" });
  await tick(5);
  assert.deepEqual(globalThis.__log, ["recordDenial:run-a:n1", "invoke:perm-d:false", "endDeniedNode:run-a:n1"]);
  assert.equal(cards().length, 0);
});

test("a stale card sends nothing and records no denial; the slice drops it on the notify", async () => {
  reset();
  add("perm-s");
  const [item] = cards();
  S.pendingApprovals.delete("perm-s"); // answered on the canvas or cleared by cancelRun
  notifyPendingApprovalsChanged();
  assert.equal(cards().length, 0);
  await item.resolve({ verdict: "deny", comment: "" });
  await tick(5);
  assert.deepEqual(globalThis.__log, []);
});
