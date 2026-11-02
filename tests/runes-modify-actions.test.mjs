// Modify's actions and Save Vault As (vault-save-as.ts, vault-modify-state.ts, view-vault.ts): a locked vault reaches the
// Make Variant / Edit Original prompt; Save Vault As calls rune_vault_create from the tab's vault; the action row reads
// Generate Runes from Local, then Save Vault As at the right (users do not write runes: no Write Rune; the Rune Library adds runes).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { vaultModifyState } = await import("../src/runes/bare/vault-modify-state.ts");
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");

function fakeIo({ locked = false } = {}) {
  const calls = [];
  const vault = { id: "copy-1", name: "", lockedUtc: locked ? "t" : null, hash: "h1", runesets: [], runes: [] };
  return {
    calls,
    read: async () => ({ vault: { ...vault }, drift: [], runes: [], warnings: [] }),
    edit: async (a) => { calls.push(["edit", a.mode, a.ops]); return { ...vault }; },
  };
}
async function mount(opts) {
  const io = fakeIo(opts);
  const vm = vaultModifyState(io);
  await vm.read("copy-1");
  return { io, vm };
}
const edits = (io) => io.calls.filter(([n]) => n === "edit");

test("a locked vault parks an edit for the Make Variant / Edit Original prompt", async () => {
  const { io, vm } = await mount({ locked: true });
  const out = await vm.commit([{ op: "addRune", ref: { library: "written", id: "be-brief" } }]);
  assert.equal(out.kind, "ask");
  assert.equal(edits(io).length, 0);
  assert.deepEqual(vm.pending?.ops, [{ op: "addRune", ref: { library: "written", id: "be-brief" } }]);
  const root = document.createElement("div");
  root.append(...vaultModify({
    view: vm.now, removed: [], pending: vm.pending, busy: false, card: { openInDocument: () => {}, note: () => {} },
    trackOpen: () => {}, pick: async () => {},
  }));
  const labels = [...root.querySelectorAll("button")].map((b) => b.textContent);
  assert.ok(labels.includes("Make Variant") && labels.includes("Edit Original"));
});

test("Save Vault As creates from the tab's vault and shows Vault Saved; an empty name sends nothing", async () => {
  const { vm } = await mount();
  const made = [];
  const create = async (a) => { made.push(a); return {}; };
  vm.saveAs.open = true;
  await vm.saveVaultAs(create);
  assert.equal(made.length, 0);
  vm.saveAs.name = " Mascot Fact ";
  await vm.saveVaultAs(create);
  assert.deepEqual(made, [{ name: "Mascot Fact", from: { vault: "copy-1", hash: "h1" }, runesets: [], runes: [] }]);
  assert.equal(vm.saveAs.saved, true);
  const root = document.createElement("div");
  root.append(...vaultModify({
    view: vm.now, removed: [], pending: null, busy: false, card: { openInDocument: () => {}, note: () => {} },
    trackOpen: () => {}, pick: async () => {},
    saveAs: { state: vm.saveAs, toggle: () => {}, save: () => {} },
  }));
  assert.match(root.textContent, /Save Vault As/);
  assert.match(root.textContent, /Vault Saved/);
});

test("the Modify action row reads Generate Runes from Local, with Save Vault As alone at the right; the Rune Library replaces Add Rune", async () => {
  const { vm } = await mount();
  const row = vaultModify({
    view: vm.now, removed: [], pending: null, busy: false, card: { openInDocument: () => {}, note: () => {} },
    trackOpen: () => {}, pick: async () => {},
    files: () => {},
    saveAs: { state: vm.saveAs, toggle: () => {}, save: () => {} },
  }).find((n) => n.className === "rp-actions");
  assert.deepEqual([...row.children].map((c) => c.className === "rp-actions-end" ? "end:" + c.textContent : c.textContent),
    ["Generate Runes from Local", "end:Save Vault As"]);
});

test("a duplicate vault name from the store lands on the Save error line", async () => {
  const { vm } = await mount();
  vm.saveAs.open = true; vm.saveAs.name = "Plain";
  await vm.saveVaultAs(async () => { throw new Error("a vault named Plain exists"); });
  assert.equal(vm.saveAs.error, "a vault named Plain exists");
  assert.equal(vm.saveAs.saved, false);
});

// Focus: an open Save Vault As form focuses Name, typing never repaints, and a repaint keeps the field's value and caret.
test("a repaint during typing keeps the Save Vault As name's value, focus and caret", async () => {
  const { mountBareView } = await import("../src/runes/bare/view.ts");
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
  const SET = { library: "installed", set: "installed" };
  const vault = { id: "daily", name: "Daily", hash: "abc", lockedUtc: null, runesets: [{ source: SET, file: "i.md", copiedUtc: "", sourceHash: "" }], runes: [], pins: {} };
  const view = { vault, runes: [{ set: SET, library: "installed", id: "r1", kind: "rule", activate: "always", description: "r1", section: [], recall: false, body: "b", drift: false }], warnings: [], drift: [] };
  const vaultEdit = { read: async () => structuredClone(view), edit: async () => structuredClone(vault) };
  const io = { localSources: async () => ({ files: [], memoryDir: null, guardsKey: false }), moduleBundles: async () => ({ bundles: {}, warnings: [] }),
    generate: async () => { throw Error("unused"); }, generateCancel: async () => null };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const h = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare", vault: { session: async () => ({ vault: { id: "daily", hash: "abc" } }), read: async () => structuredClone(view), lock: async () => vault }, vaultEdit }, io);
  try {
    await settle();
    h.modeButton.click(); await settle();
    assert.ok(![...host.querySelectorAll("button")].some((b) => b.textContent === "Write Rune"));
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Save Vault As").click();
    const name = () => host.querySelector('[data-keep="saveas-name"]');
    assert.equal(document.activeElement, name());
    const first = name();
    first.value = "Sandbox"; first.setSelectionRange(3, 3);
    first.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(name(), first, "typing does not repaint");
    h.setTrust([]); // a repaint from outside
    assert.notEqual(name(), first);
    assert.equal(name().value, "Sandbox");
    assert.equal(document.activeElement, name());
    assert.equal(name().selectionStart, 3);
  } finally { h.dispose(); host.remove(); }
});
