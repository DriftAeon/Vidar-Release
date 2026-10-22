// K regression: reopening a flow whose newest run is finished (no live session state) must show
// that run's output-node text on the Output card. run-controls.ts's refresh() used to adopt the
// shown run into S.activeRunId only while the engine held it, so the card (inspector.ts reads
// S.activeRunId) showed a leftover run's text, or none, until the run selector was toggled.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const T0 = "2026-10-02T10:00:00.000Z";
const T1 = "2026-10-02T10:05:00.000Z";

function graph(id) {
  const n = (nid, kind, title) => ({ id: nid, kind, title, x: 0, y: 0, fields: [], inputs: ["in"], outputs: ["out"] });
  const e = (from, to) => ({ id: `${from}-${to}`, from: { node: from, port: "out" }, to: { node: to, port: "in" } });
  return {
    id,
    name: id,
    updatedAt: T0,
    nodes: [n("input", "input", "Input"), n("diagnose", "agent", "Diagnose"), n("review-fix", "agent", "Review Fix"), n("output", "output", "Output")],
    edges: [e("input", "diagnose"), e("diagnose", "review-fix"), e("review-fix", "output")],
  };
}

function finishedRun(id, g, summaries) {
  const nodes = {};
  for (const node of g.nodes) {
    const ran = node.kind === "agent";
    nodes[node.id] = { nodeId: node.id, status: "ok", attempts: ran ? 1 : 0, startedAt: T0, endedAt: T1, summary: summaries[node.id] };
  }
  return { id, graphId: g.id, graphSnapshot: g, status: "success", startedAt: T0, endedAt: T1, nodes };
}

const shown = graph("g-shown");
const other = graph("g-other");
const runs = [
  finishedRun("run-shown", shown, { diagnose: "Diagnose text", "review-fix": "Final fix", output: "Final fix" }),
  finishedRun("run-other", other, { diagnose: "Other diagnose", "review-fix": "Other fix", output: "Other fix" }),
];

const dom = setupDom({
  answers: {
    flow_store_open: {
      writable: true,
      page: 1,
      seq: 0,
      lockError: null,
      entries: {
        "vidar.flow.graphs.v1": JSON.stringify({ v: 1, activeGraphId: shown.id, graphs: [shown, other] }),
        "vidar.flow.runs.v1": JSON.stringify({ v: 1, runs }),
      },
    },
    flow_store_write: (a) => ({ seq: a?.seq ?? 0 }),
    // flow_output_read: rejects by default, which must keep the summary on the card. A test
    // sets `readMode` to "defer" to hold the read until it calls `releaseReads`.
    flow_output_read: () => {
      if (readMode === "reject") return Promise.reject(new Error("no file"));
      return new Promise((resolve) => pendingReads.push(() => resolve(FULL)));
    },
    create_document: () => "C:/docs/Review Fix.md",
    stat_document: () => 0,
    write_document: (a) => {
      written.push(a.text);
      return null;
    },
  },
});
let readMode = "reject";
const pendingReads = [];
const written = [];
const FULL = "Full result ".repeat(500);
const releaseReads = () => pendingReads.splice(0).forEach((r) => r());
const { initFlowStorage } = await import("../src/flow/file-storage.ts");
const { S } = await import("../src/flow/state.ts");
// The selector opens on Run (2026-10-22); the reopened flow shows its finished run once the user picks it.
const pickShownRun = () => {
  document.querySelector(".flow-run-pick").click();
  document.querySelectorAll("#flow-pick-menu .display-pick-row")[1].click();
};
const { setSelection } = await import("../src/flow/selection.ts");
const flow = await import("../src/panels/flow.ts");
await initFlowStorage();

test("reopened flow: the Output card shows the shown run's output, not a leftover run's", async () => {
  // A leftover id from earlier in the session (another graph's run with the same node ids).
  S.activeRunId = "run-other";
  const parent = document.createElement("div");
  flow.mountFlowView(parent, () => {});
  document.body.appendChild(parent);
  flow.onFlowShown();
  pickShownRun();
  setSelection(new Set(["output"]));
  await dom.flush();

  const box = document.querySelector(".flow-pop .flow-pop-output-text");
  assert.ok(box, "Output card not rendered");
  assert.equal(box.textContent, runs[0].nodes.output.summary);
  assert.equal(S.activeRunId, "run-shown");
  flow.onFlowHidden();
  flow.disposeFlowView();
});

async function openCard() {
  S.activeRunId = "run-shown";
  const parent = document.createElement("div");
  flow.mountFlowView(parent, () => {});
  document.body.appendChild(parent);
  flow.onFlowShown();
  pickShownRun();
  setSelection(new Set(["output"]));
  await dom.flush();
  const btn = (label) => [...document.querySelectorAll(".flow-pop .flow-pop-actions button")].find((b) => b.textContent === label);
  return { parent, copy: btn("Copy"), open: btn("Open in Document"), box: document.querySelector(".flow-pop .flow-pop-output-text") };
}

function closeCard(parent) {
  flow.onFlowHidden();
  flow.disposeFlowView();
  parent.remove();
}

test("a failed full read keeps the summary visible and exports nothing from Copy or Open", async () => {
  const { setOpenInDocumentCb } = await import("../src/flow/inspector.ts");
  const opened = [];
  const copied = [];
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => void copied.push(t) }, configurable: true });
  readMode = "reject";
  written.length = 0;
  const { parent, copy, open, box } = await openCard();
  setOpenInDocumentCb((p) => opened.push(p)); // after mount: popover.ts installs its own
  assert.equal(box.textContent, "Final fix", "summary stays as the preview");
  copy.click();
  open.click();
  await dom.flush();
  await dom.flush();
  assert.deepEqual(copied, [], "Copy must not export the summary");
  assert.deepEqual(written, [], "Open must not export the summary");
  assert.deepEqual(opened, []);
  assert.match(S.flowZoomToast.textContent, /Couldn't Read Full Output/);
  closeCard(parent);
});

test("Copy and Open clicked before the read lands export the full result", async () => {
  const { setOpenInDocumentCb } = await import("../src/flow/inspector.ts");
  const opened = [];
  const copied = [];
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => void copied.push(t) }, configurable: true });
  readMode = "defer";
  written.length = 0;
  const { parent, copy, open, box } = await openCard();
  setOpenInDocumentCb((p) => opened.push(p)); // after mount: popover.ts installs its own
  assert.equal(box.textContent, "Final fix", "preview shows while the read is pending");
  assert.equal(copy.disabled, false);
  copy.click();
  open.click();
  await dom.flush();
  assert.deepEqual(copied, [], "nothing exported until the full text is read");
  releaseReads();
  for (let i = 0; i < 8; i++) await dom.flush();
  assert.deepEqual(copied, [FULL]);
  assert.deepEqual(written, [FULL]);
  assert.equal(opened.length, 1);
  assert.equal(box.textContent, FULL);
  closeCard(parent);
  readMode = "reject";
});
