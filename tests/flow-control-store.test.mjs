import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

let failGraph = false;
let holdGraph = false;
let releaseWrite;
const persisted = new Map();
const dom = setupDom({ answers: {
  flow_store_open: { writable: true, entries: {}, page: 1, seq: 0 },
  flow_store_write: ({ entries, seq }) => {
    const graphWrite = entries.some(([key, value]) => key === "vidar.flow.graphs.v1" && value?.includes("graph-control"));
    if (graphWrite && failGraph) { failGraph = false; throw new Error("disk full"); }
    if (graphWrite && holdGraph) return new Promise((resolve) => { releaseWrite = () => {
      for (const [key, value] of entries) if (value === null) persisted.delete(key); else persisted.set(key, value);
      resolve({ seq });
    }; });
    for (const [key, value] of entries) if (value === null) persisted.delete(key); else persisted.set(key, value);
    return { seq };
  },
} });
const { initFlowStorage, flowStorage } = await import("../src/flow/file-storage.ts");
const { initStore, commitControlGraph, applyTemplateDraft, setActiveGraph, onGraphEdited } = await import("../src/flow/store.ts");
const { approveSnapshot, saveSnapshot } = await import("../src/flow/control-core.ts");
const { flowCardDecision } = await import("../src/control/flow-card.ts");
const { S } = await import("../src/flow/state.ts");
const flow = await import("../src/panels/flow.ts");
await initFlowStorage();
await initStore();
await flowStorage().flush();

const graph = Object.freeze({ id: "graph-control", name: "Control", nodes: [], edges: [], updatedAt: "2026-10-18T00:00:00.000Z" });

test("failed commit rolls back the graph envelope and memory; retry publishes after ack", async () => {
  const before = flowStorage().getItem("vidar.flow.graphs.v1");
  failGraph = true;
  await assert.rejects(commitControlGraph(graph), /flush failed/);
  assert.equal(S.graphs.some((item) => item.id === graph.id), false);
  assert.equal(flowStorage().getItem("vidar.flow.graphs.v1"), before);
  assert.equal(flowStorage().captureKey("vidar.flow.graphs.v1").dirty, false);
  await commitControlGraph(graph);
  assert.equal(S.graphs.find((item) => item.id === graph.id), graph);
  assert.ok(flowStorage().getItem("vidar.flow.graphs.v1").includes(graph.id));
});

test("throwing graph notification cannot change a started reply after disk ack", async () => {
  const next = Object.freeze({ ...graph, id: "graph-notify", nodes: [{ kind: "agent" }] });
  onGraphEdited(() => { throw new Error("observer exploded"); });
  const previousError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const result = await flowCardDecision(next.id, { approved: true, shown: true, comment: "" }, false, false, false,
      () => approveSnapshot(next, { validateGraph: () => ({ valid: true, issues: [] }), reserve: () => () => {},
        preflight: () => {}, commit: commitControlGraph, start: () => "run-notify" }));
    assert.deepEqual(result, { ok: true, line: `started graph=${next.id} run=run-notify`, verdict: "approved" });
    assert.ok(logged.some((args) => String(args[0]).includes("graph edit notification failed")));
    assert.ok(persisted.get("vidar.flow.graphs.v1").includes(next.id));
  } finally { console.error = previousError; onGraphEdited(() => {}); }
});

test("start failure after disk ack restores the prior graph envelope", async () => {
  const next = Object.freeze({ ...graph, id: "graph-start-fails", nodes: [{ kind: "agent" }] });
  const before = flowStorage().getItem("vidar.flow.graphs.v1");
  const result = await flowCardDecision(next.id, { approved: true, shown: true, comment: "" }, false, false, false,
    () => approveSnapshot(next, { validateGraph: () => ({ valid: true, issues: [] }), reserve: () => () => {},
      preflight: () => {}, commit: commitControlGraph, start: () => { throw new Error("start failed"); } }));
  assert.deepEqual(result, { ok: false, line: "err start failed", verdict: "failed" });
  assert.equal(S.graphs.some((item) => item.id === next.id), false);
  assert.equal(flowStorage().getItem("vidar.flow.graphs.v1"), before);
  assert.equal(persisted.get("vidar.flow.graphs.v1"), before);
});

test("save commits the graph, starts no run and keeps the active graph", async () => {
  setActiveGraph(graph);
  const activeBefore = S.activeGraphId;
  const next = Object.freeze({ ...graph, id: "graph-saved", nodes: [{ kind: "agent" }] });
  let started = 0;
  const line = await saveSnapshot(next, { validateGraph: () => ({ valid: true, issues: [] }), commit: commitControlGraph });
  assert.equal(line, "saved graph=graph-saved");
  assert.equal(started, 0);
  assert.equal(S.activeGraphId, activeBefore);
  assert.equal(S.graphs.find((item) => item.id === next.id), next);
  await flowStorage().flush();
  assert.ok(persisted.get("vidar.flow.graphs.v1").includes("graph-saved"));
});

test("save rejects an invalid graph without committing", async () => {
  const bad = Object.freeze({ ...graph, id: "graph-bad", nodes: [{ kind: "agent" }] });
  await assert.rejects(saveSnapshot(bad, { validateGraph: () => ({ valid: false, issues: [{ message: "Nope" }] }),
    commit: () => { throw new Error("must not commit"); } }), /Nope/);
  assert.equal(S.graphs.some((item) => item.id === bad.id), false);
});

test("a panel mount during a pending commit keeps the open draft", async () => {
  const draft = applyTemplateDraft(S.templates[0].id);
  assert.ok(draft);
  const next = Object.freeze({ ...graph, id: "graph-control-2" });
  holdGraph = true;
  const pending = commitControlGraph(next);
  await dom.flush();
  assert.equal(typeof releaseWrite, "function");
  flow.mountFlowView(document.createElement("div"), () => {});
  assert.equal(S.draftGraph, draft);
  assert.equal(S.activeGraphId, draft.id);
  holdGraph = false;
  releaseWrite();
  await pending;
  assert.equal(S.draftGraph, draft);
  assert.equal(S.graphs.find((item) => item.id === next.id), next);
  flow.disposeFlowView();
});

test("switching to a template during the held commit keeps the saved active id draft-free", async () => {
  setActiveGraph(graph);
  await flowStorage().flush();
  const next = Object.freeze({ ...graph, id: "graph-control-3" });
  holdGraph = true;
  const pending = commitControlGraph(next);
  await dom.flush();
  assert.equal(typeof releaseWrite, "function");
  const draft = applyTemplateDraft(S.templates[0].id);
  assert.ok(draft);
  holdGraph = false;
  releaseWrite();
  await pending;
  await flowStorage().flush();
  const saved = JSON.parse(persisted.get("vidar.flow.graphs.v1"));
  assert.notEqual(saved.activeGraphId, draft.id);
  assert.equal(saved.graphs.some((item) => item.id === draft.id), false);
});
