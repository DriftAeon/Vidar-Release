// New Rune Vault's draft (src/runes/bare/vault-draft.ts + view.ts `draft`): the Runes view's own Modify on the blank
// Vidar-Runeset vault (`rune_vault_read{id:null, agent}`), nothing written until Done. Done opens Save Vault As's name
// prompt; its Save hands the name, a null base and the staged ops to `create`; Escape closes the prompt and stays; Cancel
// runs `cancel`.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const rune = (id) => ({ library: "vidar", id, set: null, kind: "rule", activate: "always", description: id, section: [], recall: false, body: id, path: "", drift: false });
const reads = [];
const blank = {
  vault: { id: "blank-claude", name: "", hash: "h1", lockedUtc: null, runesets: [], runes: [{ library: "vidar", id: "guide" }], pins: {} },
  runes: [rune("guide")], warnings: [], drift: [],
};
setupDom({ answers: {
  rune_vault_read: (a) => { reads.push(a); return a.id === null ? blank : Promise.reject(new Error(`no vault ${a.id}`)); },
  rune_vault_library_runes: { runes: [rune("guide")], warnings: [], runesets: [] },
} });
const { mountBareView } = await import("../src/runes/bare/view.ts");
const { draftIo } = await import("../src/runes/bare/vault-draft.ts");
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount(create = async () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const made = [], cancels = [];
  const io = draftIo("claude");
  const h = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare", retry: false, ...io,
    draft: { create: async (...a) => { made.push(a); await create(...a); }, cancel: () => cancels.push(1) } }, {});
  await settle();
  return { h, host, made, cancels };
}
const field = (host) => host.querySelector(".runes-saveas-name");

test("a draft opens straight into Modify on the blank vault, Done and Cancel shown, no Save Vault As button", async () => {
  const { h, host } = await mount();
  assert.match(h.modeButton.textContent, /Done/);
  assert.equal(h.cancelButton.hidden, false);
  assert.ok(host.querySelector(".runes-bare.is-modifying"));
  assert.ok(host.querySelector(".runes-check"), "Modify's switches drew");
  assert.ok(![...host.querySelectorAll("button")].some((b) => b.textContent === "Save Vault As"));
  h.dispose();
});

test("Done asks the name; Save hands name, a null base and the staged ops to create", async () => {
  const { h, host, made } = await mount();
  host.querySelector(".runes-check").click();
  h.modeButton.click();
  await settle();
  assert.ok(field(host), "the name prompt opened");
  assert.equal(made.length, 0, "nothing made before a name");
  field(host).value = " Daily Work ";
  field(host).dispatchEvent(new window.Event("input"));
  field(host).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  await settle();
  assert.equal(made.length, 1);
  const [name, base, ops] = made[0];
  assert.equal(name, "Daily Work");
  assert.equal(base, null, "the draft starts from the blank vault, no stored base");
  assert.deepEqual(reads[0], { id: null, agent: "claude" }, "the read names the agent and no id");
  assert.ok(ops.length >= 1, "the staged change rides along");
  h.dispose();
});

test("a name set from the head skips the prompt: Done creates with it", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const made = [];
  const h = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare", retry: false, ...draftIo("claude"),
    draft: { name: "Head Name", create: async (...a) => { made.push(a); }, cancel: () => {} } }, {});
  await settle();
  h.modeButton.click();
  await settle();
  assert.equal(field(host), null, "no name prompt");
  assert.equal(made.length, 1);
  assert.equal(made[0][0], "Head Name");
  h.dispose();
});

test("Escape closes the prompt and stays in Modify; Cancel runs the draft's cancel", async () => {
  const { h, host, made, cancels } = await mount();
  h.modeButton.click();
  await settle();
  field(host).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  await settle();
  assert.equal(field(host), null);
  assert.match(h.modeButton.textContent, /Done/);
  h.cancelButton.click();
  assert.deepEqual(cancels, [1]);
  assert.equal(made.length, 0);
  h.dispose();
});

test("a refused name shows on the prompt and keeps the draft", async () => {
  const { h, host } = await mount(async () => { throw new Error("exists: Daily Work"); });
  h.modeButton.click();
  await settle();
  field(host).value = "Daily Work";
  field(host).dispatchEvent(new window.Event("input"));
  field(host).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  await settle();
  assert.match(host.querySelector(".runes-saveas .rp-error").textContent, /exists: Daily Work/);
  assert.ok(field(host));
  h.dispose();
});

test("draft IO never writes: lock and edit refuse", async () => {
  const io = draftIo("claude");
  await assert.rejects(io.vault.lock("blank-claude", "h1"), /written only by Done/);
  await assert.rejects(io.vaultEdit.edit({ id: "blank-claude", ops: [], mode: "unlocked" }), /written only by Done/);
  assert.equal((await io.vault.session()).vault.hash, "h1");
});
