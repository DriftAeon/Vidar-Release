import test from "node:test";
import assert from "node:assert/strict";
import { deriveRaw } from "../src/panels/sessions/tab-state.ts";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({ stubs: {
  "panels/sessions/tab-row-paint": "export function startTabRowPaint() {}",
  "panels/sessions/astra-bridge": "export const armedId = null; export function disarmAstra() {}",
  "panels/sessions/output": "export function b64ToBytes() { return new Uint8Array(); } export function flowResumed() {} export function flushOutput() {} export function queueOutput() {}",
} });
const { feedRaw, dropTabState, initTabState } = await import("../src/panels/sessions/tab-state-feeds.ts");
const { get } = await import("../src/panels/sessions/tab-state-store.ts");
const { initPtyEvents } = await import("../src/panels/sessions/pty-events.ts");
initTabState();

test("Raw agent status describes the PTY lifecycle without inventing approval or failure", () => {
  for (const agent of ["claude", "codex", "gemini", "pi"]) {
    assert.deepEqual(deriveRaw(agent, true), { phase: "ready", reason: null, tool: null });
    assert.deepEqual(deriveRaw(agent, false), { phase: "dead", reason: null, tool: null });
  }
  assert.equal(deriveRaw("shell", true).phase, "unknown");
});

test("PTY exit clears green and later metadata cannot revive the terminal", () => {
  feedRaw("raw-pi", "pi", true);
  assert.equal(get("raw-pi").phase, "ready");
  feedRaw("raw-pi", "pi", false);
  document.dispatchEvent(new dom.window.CustomEvent("vidar-character-status", { detail: {
    id: "raw-pi", model: null, contextUsedPercentage: null, fresh: true,
  } }));
  assert.equal(get("raw-pi").phase, "dead");
  assert.equal(get("raw-pi").reason, null);
  dropTabState("raw-pi");
  assert.equal(get("raw-pi"), null);
});

test("stale exits preserve green; an exit before the spawn reply stays stopped", async () => {
  const button = document.createElement("button");
  const s = { id: "raw-gemini", agent: "gemini", body: "terminal", alive: true,
    ptyGen: 2, button, term: { write() {} } };
  const tabs = new Map([[s.id, s]]);
  let exits = 0;
  await initPtyEvents(tabs, () => { exits++; });
  feedRaw(s.id, s.agent, true);
  dom.ipc.listeners["pty-exit"]({ payload: { id: s.id, gen: 1 } });
  assert.equal(get(s.id).phase, "ready");
  assert.equal(s.alive, true);
  assert.equal(exits, 0);
  dom.ipc.listeners["pty-exit"]({ payload: { id: s.id, gen: 2 } });
  assert.equal(s.alive, false);
  assert.equal(button.classList.contains("dead"), true);
  assert.equal(exits, 1);
  // The successful spawn reply arrives after the accepted exit.
  feedRaw(s.id, s.agent, s.alive);
  assert.equal(get(s.id).phase, "dead");
  dropTabState(s.id);
});

