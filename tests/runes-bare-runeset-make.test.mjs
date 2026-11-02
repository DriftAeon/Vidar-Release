// Add to Vault on the generate Done line stages the generated runeset in the focused session vault's Modify; Done sends it.
// (Add Runeset, which once made an Installed runeset from local items, was removed: the Rune Library covers it.)
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({ answers: { rune_vault_library_runes: { runes: [], warnings: [] } } });
const { mountBareView } = await import("../src/runes/bare/view.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const file = (path, kind, extra = {}) => ({ path, shown: path, kind, scope: "global", ticked: false, pickable: true, ...extra });

function mounted(agent, { local, start } = {}) {
  const calls = [];
  const vault = { version: 1, id: "v1", name: "Custom", createdUtc: "2026-10-25T00:00:00Z", from: null, runesets: [], runes: [],
    lockedUtc: null, lockedBy: null, hash: "h1", pins: {} };
  const view = () => ({ vault: structuredClone(vault), drift: [], runes: [], warnings: [] });
  const io = { localSources: async () => local };
  const vaultIo = {
    session: async () => ({ version: 1, createdUtc: "", agent, body: "rendered", tab: "t1", falconSession: null, threadId: null,
      vault: { id: "v1", hash: "h1" }, home: "", loadoutHash: "" }),
    read: async () => view(),
    lock: async () => vault,
  };
  const vaultEdit = {
    read: async () => view(),
    edit: async (a) => { calls.push(["edit", a]); return { ...structuredClone(vault), id: "v1" }; },
    respawn: async () => { calls.push(["respawn"]); },
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  io.generate = async (a) => { calls.push(["generate", a]); return { library: "gen-claude-0a1b2c3d", set: "gen", runes: 1, on: 1,
    encodedChars: null, costUsd: null, inputTokens: 10, outputTokens: 5, durationMs: 1000, warnings: [] }; };
  io.generateCancel = async () => null;
  const gen = { models: [{ value: "claude-sonnet-5", label: "Sonnet 5" }] };
  const handle = mountBareView(host, { agent, cwd: "C:/work", profile: "bare", vault: vaultIo, vaultEdit, gen: () => gen, ...(start ? { start } : {}) }, io);
  return { host, calls, handle, dispose: () => { handle.dispose(); host.remove(); } };
}
const button = (host, text) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);

test("a vault tab's Modify offers no Add Runeset", async () => {
  const m = mounted("claude", { local: { memoryDir: null, guardsKey: false, files: [] } });
  await settle();
  assert.ok(!button(m.host, "Add Runeset"));
  m.dispose();
});

test("an empty Local Files view offers no Add Runeset and keeps Back", async () => {
  const m = mounted("claude", { local: { memoryDir: null, guardsKey: false, files: [] }, start: "files" });
  await settle();
  assert.ok(!button(m.host, "Add Runeset"));
  assert.ok(button(m.host, "Back"));
  m.dispose();
});

test("Local Files kind groups start collapsed under the open outer group", async () => {
  const local = { memoryDir: null, guardsKey: false, files: [file("C:/work/CLAUDE.md", "rules", { scope: "project" }), file("C:/work/a.md", "skill", { scope: "project" })] };
  const m = mounted("claude", { local, start: "files" });
  await settle();
  const groups = [...m.host.querySelectorAll("details.runes-set[data-kind]")];
  assert.ok(groups.length >= 2, "kind groups drawn");
  assert.ok(groups.every((d) => !d.open), "every kind group starts closed");
  assert.equal(m.host.querySelector(":scope details.runes-set:not([data-kind])")?.open, true, "the outer Local Files group stays open");
  m.dispose();
});

test("Add to Vault on the generate Done line adds the generated runeset to the tab's vault", async () => {
  const ticked = { memoryDir: null, guardsKey: false, files: [file("C:/work/CLAUDE.md", "rules", { ticked: true, library: "work-claude-md", scope: "project" })] };
  const m = mounted("claude", { local: ticked, start: "files" });
  await settle();
  const g = button(m.host, "Generate");
  assert.ok(!g.disabled, "a ticked rules file enables Generate");
  g.click();
  await settle();
  const add = button(m.host, "Add to Vault");
  assert.ok(add, "the Done line offers Add to Vault");
  assert.ok(add.classList.contains("ws-btn"));
  add.click();
  await settle();
  assert.deepEqual(m.calls.filter(([n]) => n === "edit"), [], "Add to Vault stages; nothing is sent before Done");
  assert.equal(m.handle.modeButton.textContent, "Done");
  m.handle.modeButton.click();
  await settle();
  assert.deepEqual(m.calls.filter(([n]) => n === "edit").map(([, a]) => a),
    [{ id: "v1", ops: [{ op: "addRuneset", ref: { library: "gen-claude-0a1b2c3d", set: "gen" } }], mode: "unlocked" }]);
  m.dispose();
});
