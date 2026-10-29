// Respawn of other tabs on an edited vault, an absent record without retry,
// the Add Rune picker's warnings, and the unlocked edit's hook into tabVaultEditIo.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { respawnVaultTabs } = await import("../src/panels/sessions/vault-tabs.ts");
const { mountBareView } = await import("../src/runes/bare/view.ts");
const { vaultModifyState } = await import("../src/runes/bare/vault-modify-state.ts");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

function deps({ vaults = {}, busy = [], raw = [], lockAfter = null }) {
  const respawned = [];
  let reads = 0;
  const ids = Object.keys(vaults);
  return {
    respawned,
    tabs: () => [{ id: "me", falconSession: null, sessionId: null }, ...ids.map((id) => ({ id, falconSession: `f-${id}`, sessionId: null }))],
    body: (id) => raw.includes(id) ? null : { isBusy: () => busy.includes(id), respawnFresh: async () => { respawned.push(id); } },
    recorded: async (id) => vaults[id] ?? null,
    locked: async () => { reads++; return lockAfter !== null && reads > lockAfter; },
  };
}

test("only idle Rendered tabs on the edited vault respawn", async () => {
  const d = deps({ vaults: { a: "v1", b: "v2", c: "v1", d: "v1", e: "v1" }, busy: ["c"], raw: ["d"] });
  assert.deepEqual(await respawnVaultTabs("v1", "me", d), ["a", "e"]);
  assert.deepEqual(d.respawned, ["a", "e"]);
});

test("the lock is re-read per tab; a vault locked meanwhile stops the rest", async () => {
  const d = deps({ vaults: { a: "v1", b: "v1", c: "v1" }, lockAfter: 1 });
  assert.deepEqual(await respawnVaultTabs("v1", "me", d), ["a"]);
});

test("a failing tab does not stop the others", async () => {
  const d = deps({ vaults: { a: "v1", b: "v1" } });
  const body = d.body;
  d.body = (id) => id === "a" ? { isBusy: () => false, respawnFresh: async () => { throw new Error("x"); } } : body(id);
  assert.deepEqual(await respawnVaultTabs("v1", "me", d), ["b"]);
});

test("without a launch vault an absent record paints No Vault Session at once", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const vault = { session: async () => null, read: async () => { throw new Error("unused"); }, lock: async () => null };
  const h = mountBareView(host, { agent: "claude", cwd: "C:/proj", profile: "bare", vault, retry: false }, {});
  await settle();
  assert.match(host.textContent, /No Vault Session/);
  h.dispose();
});

test("Add Rune keeps the library read's warnings while the list is open", async () => {
  const s = vaultModifyState({ currentView: async () => null });
  await s.toggleLibrary(async () => ({ runes: [], warnings: ["w1"] }));
  assert.deepEqual(s.libraryWarnings, ["w1"]);
  await s.toggleLibrary(async () => { throw new Error("closing needs no read"); });
  assert.deepEqual(s.libraryWarnings, []);
  await s.toggleLibrary(async () => []);
  assert.deepEqual(s.libraryWarnings, []);
});
