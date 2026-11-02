// The Runes view head's vault name (src/runes/bare/head-name.ts): a New Rune Vault draft reads "New Rune Vault" until
// named, renamed in place by the pencil (Enter commits, Escape reverts, the pencil stays); a started session's head
// shows the vault's name read-only (view.ts `headName` feeds panels/runes.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const rune = (id) => ({ library: "vidar", id, set: null, kind: "rule", activate: "always", description: id, section: [], recall: false, body: id, path: "", drift: false });
const mixed = {
  vault: { id: "mixed-vault", name: "Mixed Vault", hash: "h1", lockedUtc: null, runesets: [], runes: [{ library: "vidar", id: "guide" }], pins: {} },
  runes: [rune("guide")], warnings: [], drift: [],
};
setupDom({ answers: { rune_vault_read: mixed, rune_vault_library_runes: { runes: [rune("guide")], warnings: [], runesets: [] } } });
const { headName } = await import("../src/runes/bare/head-name.ts");
const { mountBareView } = await import("../src/runes/bare/view.ts");
const { draftIo } = await import("../src/runes/bare/vault-draft.ts");
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

function draftHead() {
  const draft = { name: "" };
  const edit = { value: () => draft.name, fallback: "New Rune Vault", set: (n) => { draft.name = n; } };
  const head = headName("runes-vault-name");
  document.body.appendChild(head.root);
  head.show("New Rune Vault", edit);
  return { draft, head };
}
const label = (head) => head.root.querySelector(".runes-vault-name-text")?.textContent;

test("a draft head reads New Rune Vault with a rename pencil until named", () => {
  const { head } = draftHead();
  assert.equal(label(head), "New Rune Vault");
  assert.ok(head.root.querySelector("button.cx-rename"));
});

test("the pencil opens a field; Enter names the draft, the head reads the name and the pencil stays", () => {
  const { draft, head } = draftHead();
  head.root.querySelector("button.cx-rename").click();
  const input = head.root.querySelector("input");
  assert.ok(input);
  input.value = " Daily Work ";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  assert.equal(draft.name, "Daily Work");
  assert.equal(label(head), "Daily Work");
  assert.equal(head.root.querySelector("input"), null);
  assert.ok(head.root.querySelector("button.cx-rename"), "the pencil stays after a rename");
});

test("Escape reverts: the draft stays unnamed", () => {
  const { draft, head } = draftHead();
  head.root.querySelector("button.cx-rename").click();
  const input = head.root.querySelector("input");
  input.value = "Nope";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(draft.name, "");
  assert.equal(label(head), "New Rune Vault");
});

test("a started session's head shows the vault's name, read-only", async () => {
  const names = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const h = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare", retry: false, ...draftIo("mixed-vault"), headName: (t) => names.push(t) }, {});
  await settle();
  assert.equal(names.at(-1), "Mixed Vault");
  const head = headName("runes-vault-name");
  head.show(names.at(-1));
  assert.equal(label(head), "Mixed Vault");
  assert.equal(head.root.querySelector("button"), null, "no pencil on a started session");
  h.dispose();
});
