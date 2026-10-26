// A stored graph's saved camera must survive a mount: mountFlowView's first applyWorldTransform
// runs at the default 0/0/1 with the active graph already loaded, and recording that overwrote the
// saved view before onFlowShown's restoreViewport read it (the "Relay Probe" graph, whose nodes sit
// at x=-112, opened offscreen every time).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const GRAPH_ID = "graph-relay-probe";
const graph = {
  id: GRAPH_ID,
  name: "Relay Probe",
  nodes: [
    { id: "input", kind: "input", title: "Input", x: -112, y: 48, fields: [], inputs: [], outputs: ["out"] },
    { id: "output", kind: "output", title: "Output", x: -112, y: 288, fields: [], inputs: ["in"], outputs: [] },
  ],
  edges: [],
  updatedAt: "2026-10-25T02:44:23.789Z",
};
const saved = { panX: 281.25, panY: 66, scale: 1.5 };
const writes = [];

const dom = setupDom({
  answers: {
    flow_store_open: {
      writable: true,
      entries: {
        "vidar.flow.graphs.v1": JSON.stringify({ v: 1, activeGraphId: GRAPH_ID, graphs: [graph] }),
        "vidar.flow.viewports.v1": JSON.stringify({ v: 1, views: { [GRAPH_ID]: saved } }),
      },
      page: 1,
      seq: 0,
    },
    flow_store_write: (a) => {
      writes.push(a);
      return { seq: a?.seq ?? 0 };
    },
  },
});
const { initFlowStorage } = await import("../src/flow/file-storage.ts");
const flow = await import("../src/panels/flow.ts");
const { S } = await import("../src/flow/state.ts");
await initFlowStorage();

test("flow mount: the active graph opens at its saved camera, not the default", async () => {
  const parent = document.createElement("div");
  flow.mountFlowView(parent, () => {});
  document.body.appendChild(parent);
  let shown;
  try {
    flow.onFlowShown();
    await dom.flush();
    shown = { id: S.activeGraphId, panX: S.panX, panY: S.panY, scale: S.scale };
  } finally {
    flow.onFlowHidden();
    flow.disposeFlowView();
    await dom.flush();
  }
  assert.deepEqual(shown, { id: GRAPH_ID, ...saved });
  const viewportWrites = JSON.stringify(writes).includes('\\"panX\\":0,\\"panY\\":0,\\"scale\\":1');
  assert.equal(viewportWrites, false, "a default 0/0/1 view was written over the saved one");
});
