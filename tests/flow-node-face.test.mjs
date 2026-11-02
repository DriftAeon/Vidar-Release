// An agent node's face shows its vault: the icon row with the vault name (the id until the list loads),
// no row when none is set, data-vault and the tooltip; refreshNodeFace picks up a change.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const T0 = "2026-10-02T10:00:00.000Z";
const graph = {
  id: "G",
  name: "G",
  updatedAt: T0,
  nodes: [
    { id: "input", kind: "input", title: "Input", x: 0, y: 0, fields: [], inputs: [], outputs: ["out"] },
    { id: "work", kind: "agent", title: "Work", x: 0, y: 100, model: "claude-opus", fields: [{ k: "task", v: "Do it" }], inputs: ["in"], outputs: ["out"] },
    { id: "output", kind: "output", title: "Output", x: 0, y: 200, fields: [], inputs: ["in"], outputs: [] },
  ],
  edges: [],
};

let release;
const gate = new Promise((r) => { release = r; });
const listed = [
  { id: "vidar-daily", name: "Daily", template: false, hash: "h", lockedUtc: null },
  { id: "mine", name: "Mine", template: false, hash: "h2", lockedUtc: null },
];
const dom = setupDom({
  answers: {
    flow_store_open: {
      writable: true, page: 1, seq: 0, lockError: null,
      entries: { "vidar.flow.graphs.v1": JSON.stringify({ v: 1, activeGraphId: "G", graphs: [graph] }) },
    },
    flow_store_write: (a) => ({ seq: a?.seq ?? 0 }),
    rune_vault_list: () => gate.then(() => listed),
  },
});
const { initFlowStorage } = await import("../src/flow/file-storage.ts");
const { S } = await import("../src/flow/state.ts");
const { refreshNodeFace } = await import("../src/flow/nodes.ts");
const flow = await import("../src/panels/flow.ts");
await initFlowStorage();

const row = (id = "work") => S.nodeEls.get(id).querySelector(".flow-node-vault");
const rowText = () => row().querySelector(".flow-node-field-v").textContent;

test("an unset vault draws no row", () => {
  const parent = document.createElement("div");
  flow.mountFlowView(parent, () => {});
  document.body.appendChild(parent);
  assert.equal(row(), null);
  assert.equal(S.nodeEls.get("input").querySelector(".flow-node-vault"), null, "only agent nodes");
});

test("a set vault shows by its id before the list loads, then by name, with data-vault and a tooltip", async () => {
  const node = S.nodes.find((n) => n.id === "work");
  node.vault = "vidar-daily";
  refreshNodeFace(node);
  assert.equal(row().dataset.vault, "vidar-daily");
  assert.equal(rowText(), "vidar-daily");
  assert.equal(row().title, "Vault: vidar-daily");
  assert.ok(row().querySelector("img.icn"), "carries the runelib icon");
  release();
  await dom.flush();
  assert.equal(rowText(), "Daily");
  assert.equal(row().title, "Vault: Daily (vidar-daily)");
  assert.equal(S.nodeEls.get("work").querySelector(".flow-node-field-v").textContent, "Do it", "field 0 stays first");
});

test("refreshNodeFace picks up a vault, title and task change", () => {
  const node = S.nodes.find((n) => n.id === "work");
  node.vault = "mine";
  node.title = "Renamed";
  node.fields[0].v = "New task";
  refreshNodeFace(node);
  assert.equal(row().dataset.vault, "mine");
  assert.equal(rowText(), "Mine");
  assert.equal(row().title, "Vault: Mine (mine)");
  assert.equal(S.nodeEls.get("work").querySelector(".flow-node-title").textContent, "Renamed");
  assert.equal(S.nodeEls.get("work").querySelector(".flow-node-field-v").textContent, "New task");
  assert.equal(S.nodeEls.get("work").querySelectorAll(".flow-node-vault").length, 1, "one vault row");
  delete node.vault;
  refreshNodeFace(node);
  assert.equal(row(), null, "clearing the vault removes the row");

  flow.disposeFlowView();
});
