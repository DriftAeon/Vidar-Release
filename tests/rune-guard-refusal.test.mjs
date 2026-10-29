// The Bare guard refusal card: Remove Rune takes the rune out of the tab's
// Rune Vault through rune_vault_edit with the lock rules, then retries the spawn; a locked vault asks first.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const calls = [];
const state = { vault: null };
const vaultOf = (o = {}) => ({ version: 1, id: "v1", name: "Custom", createdUtc: "", from: null, runesets: [],
  runes: [{ library: "kit", id: "falcon-changed-zero-check" }], lockedUtc: null, lockedBy: null, hash: "h1", pins: {}, ...o });
const dom = setupDom({ answers: {
  rune_vault_session: (args) => { calls.push(["rune_vault_session", args]); return { vault: { id: "v1", hash: "h1" } }; },
  rune_vault_read: () => ({ vault: structuredClone(state.vault), drift: [], runes: [], warnings: [] }),
  rune_vault_edit: (args) => {
    calls.push(["rune_vault_edit", args]);
    if (state.vault.lockedUtc && args.mode === "unlocked") throw new Error("vault \"v1\" is locked");
    return { ...structuredClone(state.vault), id: args.mode === "variant" ? "v2" : "v1", ...(args.mode === "variant" ? { name: "Custom Variant" } : {}) };
  },
  read_state: {},
} });
const { createLifecycle } = await import("../src/panels/rendered/lifecycle.ts");
const { runeGuardRefusal, RUNE_GUARD_REFUSAL_MARKER } = await import("../src/panels/rendered/rune-guard-error.ts");
const { MOCK_RUNE_GUARD_REFUSAL: refusal } = await import("../src/ipc-mock.ts");

const wire = `spawn: ${refusal.reason}\n${RUNE_GUARD_REFUSAL_MARKER}${JSON.stringify(refusal)}`;
const flush = async () => { for (let i = 0; i < 8; i++) await dom.flush(); };
const names = () => calls.map(([n]) => n);

function failedSpawn(agent = "claude") {
  const root = document.createElement("div");
  const notices = [];
  let attempts = 0;
  let resets = 0;
  const S = { disposed: false, spawning: null, hydrating: false, replaying: false, mode: "default", sessionId: "s1", switchPending: false };
  const life = createLifecycle(S, {
    opts: { agent, tabId: `rune-${agent}`, cwd: "C:\\work\\Checkout", onDead() {}, onAdopted() {} },
    transport: { spawn: () => Promise.reject(++attempts === 1 ? wire : "retry failed") },
    root, sl: {}, queued: [], tools: new Map(), newAdapter: () => ({}), handle() {}, hostPayload() {},
    cancelApprovals() {}, resetCache() {}, stopCacheTimer() {}, drawCache() {}, redrawStatus() {}, resetTranscript() { resets++; },
    setInTurn() {}, refreshState() {}, append: (n) => root.appendChild(n), noticeBlock: (t) => notices.push(t),
    stats: { end() {} }, openHydratedCards() {}, checkLogin() {},
  });
  return { root, notices, S, spawn: life.spawn, attempts: () => attempts, resets: () => resets };
}
const card = (f) => f.root.querySelector(".blk-notice-card");
const buttons = (el) => [...el.querySelectorAll("button")].map((b) => b.textContent);
const press = (el, label) => [...el.querySelectorAll("button")].find((b) => b.textContent === label).click();

test("tagged Bare refusal keeps the reason and originating rune identity", () => {
  assert.deepEqual(runeGuardRefusal(wire), refusal);
  assert.equal(runeGuardRefusal("ordinary spawn error"), null);
  assert.equal(runeGuardRefusal(`${RUNE_GUARD_REFUSAL_MARKER}{"id":"x"}`), null);
});

test("Failed to Start card names the rune; Remove Rune edits the open vault before retry", async () => {
  calls.length = 0; state.vault = vaultOf();
  const f = failedSpawn();
  await f.spawn();
  const c = card(f);
  assert.equal(c.querySelector(".blk-notice").textContent, "Rune Falcon Changed Zero Check Holds Your Account Name");
  assert.deepEqual(buttons(c), ["Remove Rune"]);
  assert.equal(f.root.querySelector(".rendered-retry"), null);
  assert.deepEqual(f.notices, []);
  const button = c.querySelector("button");
  assert.ok(button.classList.contains("wb-card-btn-primary") && button.classList.contains("notice-trust"));
  button.click();
  assert.equal(f.attempts(), 1, "retry waits for the vault edit");
  await flush();
  assert.deepEqual(calls.filter(([n]) => n === "rune_vault_edit").map(([, a]) => a),
    [{ id: "v1", ops: [{ op: "removeRune", ref: { library: "kit", id: "falcon-changed-zero-check" } }], mode: "unlocked" }]);
  assert.equal(f.attempts(), 2);
  assert.equal(f.S.sessionId, "s1", "an open vault's retry keeps the session");
  assert.equal(card(f), null);
  assert.deepEqual(f.notices, ["Failed to Start: retry failed"]);
});

test("a locked vault sends no edit until the pick; Make Variant saves the variant, leaves the tab on its vault and shows the notice", async () => {
  calls.length = 0; state.vault = vaultOf({ lockedUtc: "2026-10-25T00:00:00Z" });
  const f = failedSpawn();
  await f.spawn();
  press(card(f), "Remove Rune");
  await flush();
  assert.ok(!names().includes("rune_vault_edit"), "a locked vault is never edited before the pick");
  assert.equal(f.attempts(), 1);
  assert.equal(card(f).querySelector(".blk-notice").textContent,
    "Rune Falcon Changed Zero Check Holds Your Account Name. This vault is locked. Earlier sessions on this vault become invalid. Edit Original restarts this tab on the edited vault.");
  assert.deepEqual(buttons(card(f)), ["Make Variant", "Edit Original"]);
  press(card(f), "Make Variant");
  await flush();
  assert.deepEqual(calls.filter(([n]) => n === "rune_vault_edit").map(([, a]) => a.mode), ["variant"]);
  assert.ok(!names().includes("rune_vault_session_move"), "no caller moves the tab's record any more");
  assert.equal(f.attempts(), 1, "the tab keeps its vault, so there is nothing to retry");
  assert.equal(f.S.sessionId, "s1");
  assert.equal(card(f).querySelector(".blk-notice").textContent, "Saved as Custom Variant. New sessions can pick it.");
  assert.deepEqual(buttons(card(f)), []);
});

test("Edit Original edits the locked vault in place and retries fresh, as Modify's choice respawns", async () => {
  calls.length = 0; state.vault = vaultOf({ lockedUtc: "2026-10-25T00:00:00Z" });
  const f = failedSpawn();
  await f.spawn();
  press(card(f), "Remove Rune");
  await flush();
  press(card(f), "Edit Original");
  await flush();
  assert.deepEqual(calls.filter(([n]) => n === "rune_vault_edit").map(([, a]) => a.mode), ["invalidate"]);
  assert.equal(f.attempts(), 2);
  assert.equal(f.S.sessionId, null, "Edit Original's retry starts a fresh session");
});

test("a rune that rides in a placed runeset goes out of the vault's copy through the member op", async () => {
  calls.length = 0;
  state.vault = vaultOf({ runes: [], runesets: [{ file: "sets/kit--workflow.md", source: { library: "kit", set: "workflow" }, copiedUtc: "", sourceHash: "" }] });
  const f = failedSpawn();
  await f.spawn();
  press(card(f), "Remove Rune");
  await flush();
  assert.deepEqual(calls.filter(([n]) => n === "rune_vault_edit").map(([, a]) => a), [{ id: "v1", mode: "unlocked",
    ops: [{ op: "member", ref: { library: "kit", runeset: "workflow", rune: { library: "kit", id: "falcon-changed-zero-check" }, on: false } }] }]);
  assert.equal(f.attempts(), 2);
});

test("a rune from a runeset the vault does not hold shows the error line and edits nothing", async () => {
  calls.length = 0; state.vault = vaultOf({ runes: [] });
  const f = failedSpawn();
  await f.spawn();
  press(card(f), "Remove Rune");
  await flush();
  assert.ok(!names().includes("rune_vault_edit"));
  assert.equal(f.attempts(), 1);
  const err = card(f).querySelector(".notice-err");
  assert.ok(err && !err.hidden);
  assert.match(err.textContent, /comes with a runeset/);
});

test("Codex Bare uses the same refusal card", async () => {
  state.vault = vaultOf();
  const f = failedSpawn("codex");
  await f.spawn();
  assert.equal(f.root.querySelector(".blk-notice-card .blk-notice").textContent, "Rune Falcon Changed Zero Check Holds Your Account Name");
  assert.deepEqual(buttons(f.root), ["Remove Rune"]);
});
