// lifecycle.ts spawn writes the mode pill's label before any mode event arrives: it must use the
// tab's agent, so a Codex tab in auto mode reads "Auto Review" from spawn, not "Auto".
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({ answers: { read_state: {}, patch_state: null } });
const { createLifecycle } = await import("../src/panels/rendered/lifecycle.ts");

function spawnLabel(agent) {
  const S = { disposed: false, spawning: null, sessionId: null, characterModelLive: false, liveEffort: null,
    switchPending: false, mode: "auto", gen: 0, isAlive: false };
  const sl = { model: "", mode: "" };
  let atSpawn = null;
  const noop = () => {};
  const life = createLifecycle(S, {
    opts: { agent, tabId: `mode-label-${agent}`, cwd: "C:/work" },
    root: document.createElement("div"), sl, newAdapter: () => ({}), cancelApprovals: noop,
    settleSwitch: noop, resetCache: noop, redrawStatus: noop, handle: noop, hostPayload: noop, noticeBlock: noop,
    // the label is read where the spawn starts; the spawn never resolves, so nothing after it runs
    transport: { spawn: () => { atSpawn = sl.mode; return new Promise(() => {}); } },
  });
  void life.spawn();
  return new Promise((resolve) => setImmediate(() => resolve(atSpawn)));
}

test("a Codex tab's auto mode reads Auto Review from spawn, before any mode event", async () => {
  assert.equal(await spawnLabel("codex"), "Auto Review");
});

test("a Claude tab's auto mode reads Auto from spawn", async () => {
  assert.equal(await spawnLabel("claude"), "Auto");
});
