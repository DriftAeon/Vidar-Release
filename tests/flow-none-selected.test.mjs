// Deleting the open flow leaves none selected (2026-10-16): the picker face reads No Flow,
// the canvas shows its empty state, the editing controls are off, the null persists, and a
// template restores normal use. Deleting another flow keeps the selection.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const T0 = "2026-10-02T10:00:00.000Z";
const graph = (id, updatedAt) => ({
  id,
  name: id,
  updatedAt,
  nodes: [
    { id: "input", kind: "input", title: "Input", x: 0, y: 0, fields: [], inputs: [], outputs: ["out"] },
    { id: "output", kind: "output", title: "Output", x: 0, y: 100, fields: [], inputs: ["in"], outputs: [] },
  ],
  edges: [{ id: "e1", from: { node: "input", port: "out" }, to: { node: "output", port: "in" } }],
});

setupDom({
  answers: {
    flow_store_open: {
      writable: true,
      page: 1,
      seq: 0,
      lockError: null,
      entries: {
        "vidar.flow.graphs.v1": JSON.stringify({ v: 1, activeGraphId: "Alpha", graphs: [graph("Alpha", T0), graph("Beta", T0), graph("Gamma", T0)] }),
      },
    },
    flow_store_write: (a) => ({ seq: a?.seq ?? 0 }),
  },
});
const { initFlowStorage, flowStorage } = await import("../src/flow/file-storage.ts");
const { S } = await import("../src/flow/state.ts");
const flow = await import("../src/panels/flow.ts");
await initFlowStorage();

const parent = document.createElement("div");
flow.mountFlowView(parent, () => {});
document.body.appendChild(parent);

const face = () => document.querySelector(".flow-pick .nm").textContent;
const emptyEl = () => document.querySelector(".flow-empty");
const stored = () => JSON.parse(flowStorage().getItem("vidar.flow.graphs.v1"));

function openMenu() {
  if (!document.querySelector("#flow-pick-menu")) document.querySelector(".flow-pick").click();
  return document.querySelector("#flow-pick-menu");
}

function deleteRow(name) {
  const item = [...openMenu().querySelectorAll(".flow-pick-item")].find((i) => i.querySelector(".nm").textContent === name);
  item.querySelector(".flow-pick-del").click();
  document.querySelector(".swap-yes").click();
}

test("deleting a flow that is not open keeps the selection", () => {
  assert.equal(face(), "Alpha");
  deleteRow("Gamma");
  assert.equal(S.activeGraphId, "Alpha");
  assert.equal(face(), "Alpha");
  assert.equal(emptyEl().hidden, true);
  assert.deepEqual(stored().graphs.map((g) => g.id), ["Alpha", "Beta"]);
});

test("deleting the open flow leaves none selected and the editor off", () => {
  deleteRow("Alpha");
  assert.equal(S.activeGraphId, null);
  assert.equal(S.draftGraph, null);
  assert.equal(S.nodes.length, 0);
  assert.equal(S.nodeEls.size, 0);
  assert.equal(face(), "No Flow");
  assert.equal(emptyEl().hidden, false);
  assert.equal(document.querySelector(".flow-plus-btn").disabled, true);
  assert.equal(document.querySelector(".flow-tidy-btn").disabled, true);
  assert.equal(document.querySelector(".flow-run-btn").disabled, true);
  assert.equal(document.querySelector(".flow-reset").hidden, true);
  const env = stored();
  assert.equal(env.activeGraphId, null);
  assert.deepEqual(env.graphs.map((g) => g.id), ["Beta"]);
  assert.ok(!env.graphs.some((g) => /Untitled/.test(g.name)));
});

test("picking a template opens it and restores normal use", () => {
  const row = [...openMenu().querySelectorAll(".display-pick-row")].find((r) => !r.closest(".flow-pick-item") && !r.classList.contains("flow-pick-head"));
  row.click();
  assert.notEqual(S.activeGraphId, null);
  assert.notEqual(face(), "No Flow");
  assert.equal(emptyEl().hidden, true);
  assert.equal(document.querySelector(".flow-plus-btn").disabled, false);
  assert.equal(document.querySelector(".flow-tidy-btn").disabled, false);
  flow.disposeFlowView();
});

test("a panel remount keeps the open unsaved draft without persisting it", () => {
  // The template above is an unsaved draft: the stored active id is still null.
  assert.equal(stored().activeGraphId, null);
  const draftId = S.draftGraph.id;
  const again = document.createElement("div");
  flow.mountFlowView(again, () => {});
  document.body.appendChild(again);
  assert.equal(S.activeGraphId, draftId);
  assert.equal(S.draftGraph.id, draftId);
  assert.notEqual(face(), "No Flow");
  assert.equal(emptyEl().hidden, true);
  assert.deepEqual(stored().graphs.map((g) => g.id), ["Beta"]);
  flow.disposeFlowView();
});
