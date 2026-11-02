// vault-names.ts reads rune_vault_list once at Flow mount; the first card open after it reuses that read
// (mount + first open = 1 call), a re-render never fetches, and the second open reads again so a vault
// saved in between is listed.
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
    { id: "work", kind: "agent", title: "Work", x: 0, y: 100, model: "claude-opus", fields: [{ k: "task", v: "" }], inputs: ["in"], outputs: ["out"] },
    { id: "output", kind: "output", title: "Output", x: 0, y: 200, fields: [], inputs: ["in"], outputs: [] },
  ],
  edges: [],
};

let vaults = [{ id: "vidar-daily", name: "Daily", template: false, hash: "h", lockedUtc: null }];
const dom = setupDom({
  answers: {
    flow_store_open: {
      writable: true, page: 1, seq: 0, lockError: null,
      entries: { "vidar.flow.graphs.v1": JSON.stringify({ v: 1, activeGraphId: "G", graphs: [graph] }) },
    },
    flow_store_write: (a) => ({ seq: a?.seq ?? 0 }),
    rune_vault_list: () => vaults,
  },
});
const { initFlowStorage } = await import("../src/flow/file-storage.ts");
const { setSelection } = await import("../src/flow/selection.ts");
const { renderInspector } = await import("../src/flow/inspector.ts");
const { S } = await import("../src/flow/state.ts");
const flow = await import("../src/panels/flow.ts");
await initFlowStorage();

const calls = () => dom.ipc.invoked.filter((c) => c === "rune_vault_list").length;
const options = () => [...document.querySelectorAll(".flow-pop select[aria-label='Vault'] option")].map((o) => o.value);

test("mount plus first open reads once, none per re-render, a new vault is listed on the next open", async () => {
  const parent = document.createElement("div");
  flow.mountFlowView(parent, () => {});
  document.body.appendChild(parent);
  flow.onFlowShown();
  await dom.flush();
  assert.equal(calls(), 1, "mount loads the names");

  setSelection(new Set(["work"]));
  await dom.flush();
  assert.equal(calls(), 1);
  assert.deepEqual(options(), ["", "vidar-daily"], "an unset vault leads with the Pick a Vault prompt");

  const node = S.nodes.find((n) => n.id === "work");
  for (let i = 0; i < 3; i++) renderInspector(node);
  await dom.flush();
  assert.equal(calls(), 1, "re-renders never fetch");

  setSelection(new Set());
  await dom.flush();
  vaults = [...vaults, { id: "mine", name: "Mine", template: false, hash: "h2", lockedUtc: null }];
  setSelection(new Set(["work"]));
  await dom.flush();
  assert.equal(calls(), 2, "the second open fetches once");
  assert.ok(options().includes("mine"), "vault saved since the first open is listed");

  flow.onFlowHidden();
  flow.disposeFlowView();
});
