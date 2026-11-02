// A Rendered Bare tab that waits for its Rune Vault (panels/rendered/vault-gate.ts): lifecycle spawn() holds
// until the pick, every route into spawn shares the one wait, a closed tab spawns nothing, and the saved-tabs
// snapshot skips a tab still picking.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

globalThis.__codexSaveWrites = [];
setupDom({ stubs: {
  prefs: `export function setPref(k, v) { globalThis.__codexSaveWrites.push([k, v]); return true; }
    export function getPref() { return undefined; }`,
} });
const { createLifecycle } = await import("../src/panels/rendered/lifecycle.ts");
const { createVaultGate } = await import("../src/panels/rendered/vault-gate.ts");
const { chipState } = await import("../src/panels/rendered/state-chip.ts");
const { bindCodexSave, saveCodexTabs } = await import("../src/panels/sessions/codex-save.ts");

function build(gate) {
  const S = { disposed: false, spawning: null, sessionId: null, characterModelLive: false, liveEffort: null,
    switchPending: false, mode: "default", gen: 0, isAlive: false, holding: false, pendingApproval: false, inTurn: false };
  const sl = { model: "", mode: "", ctxTokens: 0, ctxPct: null };
  const noop = () => {};
  const spawns = [];
  const life = createLifecycle(S, {
    opts: { agent: "claude", tabId: "gate-tab", cwd: "C:/work", vaultGate: gate },
    root: document.createElement("div"), sl, newAdapter: () => ({ attach: noop, start: noop }), cancelApprovals: noop,
    settleSwitch: noop, resetCache: noop, redrawStatus: noop, refreshState: noop, resetTranscript: noop,
    handle: noop, hostPayload: noop, noticeBlock: noop, queued: [], tools: new Map(),
    transport: { spawn: () => { spawns.push(1); return new Promise(() => {}); }, kill: async () => {} },
  });
  return { S, life, spawns };
}
const tick = () => new Promise((r) => setImmediate(r));

test("no spawn before the pick; one spawn after it", async () => {
  const gate = createVaultGate();
  const { life, spawns } = build(gate);
  void life.spawn();
  await tick();
  assert.equal(spawns.length, 0);
  assert.equal(gate.pick("team-daily"), true);
  await tick();
  assert.equal(spawns.length, 1);
  assert.equal(gate.picked(), "team-daily");
  assert.equal(gate.pick("other"), false, "the first pick stands");
});

test("a pick that lands before the body mounts spawns at once", async () => {
  const gate = createVaultGate();
  gate.pick("team-main");
  const { life, spawns } = build(gate);
  void life.spawn();
  await tick();
  assert.equal(spawns.length, 1);
});

test("a tab with no gate, or a released one, spawns as before", async () => {
  const { life, spawns } = build(null);
  void life.spawn();
  await tick();
  assert.equal(spawns.length, 1);
});

test("dispose while pending spawns nothing", async () => {
  const gate = createVaultGate();
  const { S, life, spawns } = build(gate);
  void life.spawn();
  S.disposed = true;
  gate.cancel();
  await tick();
  assert.equal(spawns.length, 0);
  assert.equal(gate.pending, false);
});

test("/clear, Restart and respawnFresh wait for the pick and share one spawn", async () => {
  const gate = createVaultGate();
  const { life, spawns } = build(gate);
  void life.spawn(); // first start
  void life.spawn(); // /clear or Restart
  const fresh = life.respawnFresh(); // a vault edit's respawn
  await tick();
  assert.equal(spawns.length, 0);
  gate.pick("team-daily");
  await tick();
  assert.equal(spawns.length, 1);
  void fresh;
});

test("the chip reads Picking while the tab waits, ahead of Stopped", () => {
  const S = { hydrating: false, disconnected: false, isAlive: false, pendingApproval: false, inTurn: false, loggedOut: false, sessionId: null, costTotal: 0, picking: true };
  const chip = chipState(S, false, 0);
  assert.equal(chip.key, "picking");
  assert.match(chip.title, /^Picking/);
  assert.equal(chipState({ ...S, picking: false }, false, 0).key, "stopped");
});

test("the saved-tabs snapshot skips a Codex tab still picking its vault", () => {
  const button = (title) => Object.assign(document.createElement("button"), { title });
  const tab = (id, extra) => ({
    id, agent: "codex", body: "rendered", cwd: "C:\\w", model: "gpt", permissionMode: "default", profile: "bare", rowKey: `row-${id}`,
    button: button(id), rendered: { sessionId: () => null, permissionMode: () => "default", hosted: () => false }, ...extra,
  });
  const waiting = createVaultGate();
  const picked = createVaultGate();
  picked.pick("team-main");
  const sessions = new Map([["a", tab("a", { pendingVault: waiting })], ["b", tab("b", { pendingVault: picked })], ["c", tab("c")]]);
  globalThis.__codexSaveWrites.length = 0;
  bindCodexSave({ sessions, orderedIds: () => ["a", "b", "c"], getActiveId: () => "c" });
  saveCodexTabs();
  const [, list] = globalThis.__codexSaveWrites.find(([name]) => name === "rendered.codexTabs");
  assert.deepEqual(list.map((r) => r.title), ["b", "c"]);
});
