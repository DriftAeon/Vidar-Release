// The node card edits show on the node as you type: every Task/Content input repaints the node face
// (no blur needed), a rebuild that lands while focus is in the card (a Vault change, the vault list
// resolving mid-typing) keeps focus and the caret on the same control, Escape closes and keeps the
// edits, Close keeps working across reopen cycles, and every card field has an accessible name.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const T0 = "2026-10-02T10:00:00.000Z";
const graph = {
  id: "G",
  name: "G",
  updatedAt: T0,
  nodes: [
    { id: "input", kind: "input", title: "Input", x: 0, y: 0, fields: [{ k: "shape", v: "free-text" }, { k: "content", v: "" }], inputs: [], outputs: ["out"] },
    {
      id: "work", kind: "agent", title: "Work", x: 0, y: 100, model: "claude-opus",
      fields: [{ k: "task", v: "" }], addons: [{ kind: "retries", label: "1", value: "1" }],
      inputs: ["in"], outputs: ["out"],
    },
    { id: "output", kind: "output", title: "Output", x: 0, y: 200, fields: [], inputs: ["in"], outputs: [] },
  ],
  edges: [],
};

const vaults = [
  { id: "vidar-daily", name: "Daily", template: false, hash: "h", lockedUtc: null },
  { id: "mine", name: "Mine", template: false, hash: "h2", lockedUtc: null },
];
// Every rune_vault_list read waits for `releaseVaults`, so a test decides when the list lands.
const pendingVaults = [];
const releaseVaults = () => pendingVaults.splice(0).forEach((r) => r());
const dom = setupDom({
  answers: {
    flow_store_open: {
      writable: true, page: 1, seq: 0, lockError: null,
      entries: { "vidar.flow.graphs.v1": JSON.stringify({ v: 1, activeGraphId: "G", graphs: [graph] }) },
    },
    flow_store_write: (a) => ({ seq: a?.seq ?? 0 }),
    rune_vault_list: () => new Promise((r) => pendingVaults.push(() => r(vaults))),
  },
});
const { initFlowStorage } = await import("../src/flow/file-storage.ts");
const { setSelection } = await import("../src/flow/selection.ts");
const { S } = await import("../src/flow/state.ts");
const flow = await import("../src/panels/flow.ts");
await initFlowStorage();
test.after(() => {
  releaseVaults();
  flow.onFlowHidden();
  flow.disposeFlowView();
});

const parent = document.createElement("div");
flow.mountFlowView(parent, () => {});
document.body.appendChild(parent);
flow.onFlowShown();
// jsdom has no layout: give the canvas a rect so the card is not hidden as off-canvas.
S.canvasEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 });
await dom.flush();
releaseVaults();
await dom.flush();

// Node's own Event is not jsdom's; build events from the DOM's window.
const { Event, KeyboardEvent } = document.defaultView;
const card = () => S.inspectorEl;
const named = (label) => card().querySelector(`[aria-label='${label}']`);
const node = (id) => S.nodes.find((n) => n.id === id);
const face = (id) => S.nodeEls.get(id).querySelector(".flow-node-field:not(.flow-node-vault) .flow-node-field-v");
const open = async (id) => {
  setSelection(new Set([id]));
  await dom.flush();
  releaseVaults();
  await dom.flush();
};
const close = async () => {
  setSelection(new Set());
  await dom.flush();
};
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

test("each input updates node.fields and the node face with no blur, keeping the last character", async () => {
  await open("work");
  const task = named("Task");
  task.focus();
  for (const v of ["D", "Do", "Do i", "Do it"]) {
    type(task, v);
    assert.equal(node("work").fields[0].v, v);
    assert.equal(face("work").textContent, v);
  }
  assert.equal(document.activeElement, task, "typing never blurs the field");
  await close();

  await open("input");
  const content = named("Content");
  content.focus();
  for (const v of ["A", "An", "Ans"]) {
    type(content, v);
    assert.equal(node("input").fields[1].v, v);
  }
  assert.equal(document.activeElement, content);
  await close();
});

test("a Vault change keeps focus on the Vault select", async () => {
  await open("work");
  const vault = named("Vault");
  vault.focus();
  vault.value = "mine";
  vault.dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(node("work").vault, "mine");
  assert.notEqual(named("Vault"), vault, "the card was rebuilt");
  assert.equal(document.activeElement, named("Vault"));
  assert.equal(S.nodeEls.get("work").querySelector(".flow-node-vault").dataset.vault, "mine", "the face shows the new vault");
  delete node("work").vault;
  await close();
});

test("typing in Task while the vault fetch resolves keeps focus and the caret in Task", async () => {
  setSelection(new Set(["work"]));
  await dom.flush();
  assert.ok(pendingVaults.length > 0, "the card open is waiting on a vault read");
  const before = named("Task");
  before.focus();
  type(before, "Write it");
  before.setSelectionRange(3, 5);
  releaseVaults();
  await dom.flush();
  await dom.flush();
  const after = named("Task");
  assert.notEqual(after, before, "the vault list redrew the card");
  assert.equal(document.activeElement, after);
  assert.equal(after.value, "Write it");
  assert.equal(after.selectionStart, 3);
  assert.equal(after.selectionEnd, 5);
  await close();
});

test("a rebuild with focus outside the card takes no focus", async () => {
  await open("work");
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  outside.focus();
  const { renderInspector } = await import("../src/flow/inspector.ts");
  renderInspector(node("work"));
  assert.equal(document.activeElement, outside);
  outside.remove();
  await close();
});

test("Escape from Task closes the card and keeps the task", async () => {
  await open("work");
  const task = named("Task");
  task.focus();
  type(task, "Kept task");
  task.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await dom.flush();
  assert.equal(S.selected.size, 0);
  assert.equal(card().style.display, "none");
  assert.equal(node("work").fields[0].v, "Kept task");
  assert.equal(face("work").textContent, "Kept task");
});

test("Close, reopen, Close works for three cycles", async () => {
  for (let i = 0; i < 3; i++) {
    await open("work");
    assert.notEqual(card().style.display, "none", `cycle ${i}: card open`);
    const x = named("Close");
    assert.ok(x, `cycle ${i}: Close present`);
    x.click();
    await dom.flush();
    assert.equal(S.selected.size, 0, `cycle ${i}: Close cleared the selection`);
    assert.equal(card().style.display, "none", `cycle ${i}: card closed`);
  }
});

test("every textarea, input and select in the agent and input cards has an accessible name", async () => {
  for (const id of ["work", "input"]) {
    await open(id);
    // The title's in-place editor and a modifier's text editor are inputs too.
    card().querySelector(".flow-pop-title").click();
    const fields = [...card().querySelectorAll("textarea, input, select")];
    assert.ok(fields.length >= 2, `${id}: card has fields`);
    for (const el of fields) {
      const name = el.getAttribute("aria-label") || (el.id && card().querySelector(`label[for='${el.id}']`)?.textContent);
      assert.ok(name && name.trim(), `${id}: ${el.tagName}.${el.className} has no accessible name`);
    }
    assert.equal(named("Title")?.tagName, "INPUT");
    card().querySelector(".flow-inspector-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await close();
  }
  await open("work");
  assert.equal(named("Retries")?.tagName, "SELECT");
  await close();
});

test("the card's add button reads Add Modifier", async () => {
  await open("work");
  assert.equal(card().querySelector(".flow-pop-chip-add").textContent, "Add Modifier");
  await close();
});

test("the card stays left of #toolbench when the canvas runs under it", async () => {
  const rail = document.createElement("section");
  rail.id = "toolbench";
  rail.getBoundingClientRect = () => ({ left: 500, top: 0, right: 560, bottom: 700, width: 60, height: 700 });
  document.body.appendChild(rail);
  try {
    await open("work");
    const left = parseFloat(card().style.left);
    assert.ok(left >= 0 && left + 300 <= 500, `card spans ${left}..${left + 300}, past the rail at 500`);
  } finally {
    rail.remove();
    await close();
  }
});
