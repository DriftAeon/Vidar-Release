import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({ stubs: { "panels/sessions/lookup": `
  export const getFocusedSession = () => globalThis.__focus ?? null;
  export const renderedSessionId = () => null;
  export const renderedBody = () => null;
  export const sessionLaunchInfo = () => null;` } });
const { createBareIo } = await import("../src/runes/bare/io.ts");
const { mountRunesView, onRunesShown, disposeRunesView } = await import("../src/panels/runes.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

const vault = { id: "daily", name: "Daily", hash: "abc", runesets: [], runes: [], lockedUtc: null, pins: {} };
dom.ipc.answers.runes_catalog = { libraries: [] };
dom.ipc.answers.runes_loaded = { source: "none", reason: "No Loads Recorded", files: [] };
dom.ipc.answers.bare_local_sources = { files: [], memoryDir: null, guardsKey: false };
dom.ipc.answers.rune_vault_session = { vault: { id: "daily", hash: "abc" } };
dom.ipc.answers.rune_vault_read = { vault, runes: [], warnings: [], drift: [] };
const bare = { id: "t1", title: "T", agent: "claude", art: "claude", cwd: "C:/proj", profile: "bare" };
const raw = { id: "t2", title: "R", agent: "claude", art: "claude", cwd: "C:/proj" };
const parent = document.createElement("div");
document.body.appendChild(parent);
mountRunesView(parent, () => {}, () => {});

test("The panel reads a Bare tab's pinned vault, without a row content read", async () => {
  globalThis.__focus = bare;
  onRunesShown();
  await settle();
  assert.ok(parent.querySelector(".runes-bare"));
  assert.ok(dom.ipc.invoked.includes("rune_vault_session"));
  assert.ok(dom.ipc.invoked.includes("rune_vault_read"));
  assert.ok(!dom.ipc.invoked.some((cmd) => ["bare_actives", "bare_launch",
    "rune_set_toggle", "bare_set_layer_write"].includes(cmd)));
});

test("A finished turn on the focused Bare tab re-reads its vault, so a first-message lock shows Locked", async () => {
  // E1 run 3 case 7: the vault locked at the first send, the view kept "Lock" until a tab switch
  const reads = () => dom.ipc.invoked.filter((cmd) => cmd === "rune_vault_read").length;
  const before = reads();
  dom.ipc.answers.rune_vault_read = { vault: { ...vault, lockedUtc: "2026-10-28T07:24:48Z" }, runes: [], warnings: [], drift: [] };
  document.dispatchEvent(new window.CustomEvent("vidar-reply-done", { detail: { id: "t1", agent: "claude", cwd: "C:/proj" } }));
  await settle();
  assert.ok(reads() > before, "the reply re-reads the vault");
  assert.equal(parent.querySelector(".runes-lock:not([hidden]) span")?.textContent.trim(), "Locked");
  const after = reads();
  document.dispatchEvent(new window.CustomEvent("vidar-reply-done", { detail: { id: "other", agent: "claude", cwd: "C:/proj" } }));
  await settle();
  assert.equal(reads(), after, "another tab's reply reads nothing");
  dom.ipc.answers.rune_vault_read = { vault, runes: [], warnings: [], drift: [] };
});

test("Switching focus away removes the Bare view", async () => {
  globalThis.__focus = raw;
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await settle();
  assert.equal(parent.querySelector(".runes-bare"), null);
  disposeRunesView();
});

test("The Bare IO binds local item import arguments and returns refs", async () => {
  const calls = [];
  const io = createBareIo(async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "bare_items_import") return { runes: [{ library: "kit", id: "review", kind: "skill" }], dropped: [] };
    return null;
  }, async () => () => {});
  const result = await io.itemsImport({ library: "kit", layer: { skills: ["C:/skills/review"] } });
  assert.deepEqual(calls, [["bare_items_import", { library: "kit", layer: { skills: ["C:/skills/review"] } }]]);
  assert.equal(result.runes[0].id, "review");
});
