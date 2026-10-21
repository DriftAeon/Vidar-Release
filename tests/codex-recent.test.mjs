// Resume must carry the stored thread model, rather than silently applying the launcher default.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const state = { rows: [], calls: [], open: [], column: null, refreshCalls: 0, refreshRowsAtCall: [] };
globalThis.__codexRecent = state;
setupDom({ answers: { list_codex_threads: () => state.rows }, stubs: {
  "panels/sessions": `export const codexThreadHolder = (id) => globalThis.__codexRecent.open.includes(id) ? "tab" : null;
    export async function refreshRawCodexThreads() {
      const state = globalThis.__codexRecent;
      state.refreshCalls++;
      state.refreshRowsAtCall.push(state.column.querySelectorAll("button").length);
    }`,
  "launcher/columns": "export const openColumn = () => globalThis.__codexRecent.column; export function placeColumn() {} export function hoverOpen() {}",
  "launcher/roster": "export async function spawnFrom(...args) { globalThis.__codexRecent.calls.push(args); return 'tab'; }",
} });
const { openCodexRecent } = await import("../src/launcher/codex-recent.ts");
const { resetRecentCache } = await import("../src/launcher/recent-cache.ts");
const rendered = { id: "codex", body: "rendered", model: "launcher-default", cwd: "C:/override" };
const row = (model) => ({ id: "thread", label: "Saved Thread", cwd: "C:/thread", ageSecs: 10, model });

test("resume uses the thread's model, falling back only when its metadata has none", async () => {
  for (const model of ["saved-model", null, ""]) {
    resetRecentCache();
    state.rows = [row(model)]; state.calls = []; state.open = []; state.column = document.createElement("div");
    await openCodexRecent(rendered, rendered, { label: "Work", cwd: "C:/location" }, document.createElement("button"), 1, () => false);
    state.column.querySelector("button").click();
    assert.equal(state.calls.length, 1);
    const [agent, loc, title, resume] = state.calls[0];
    assert.equal(agent.model, model || "launcher-default");
    assert.equal(agent.cwd, undefined);
    assert.equal(loc.cwd, "C:/thread");
    assert.equal(title, undefined);
    assert.equal(resume, "thread");
    assert.equal(rendered.model, "launcher-default", "the shared launcher row must not be mutated");
  }
});

test("a held thread renders inert before it can spawn", async () => {
  resetRecentCache();
  state.rows = [row("saved-model")]; state.calls = []; state.open = ["thread"];
  state.column = document.createElement("div"); state.refreshCalls = 0; state.refreshRowsAtCall = [];
  await openCodexRecent(rendered, rendered, { label: "Work", cwd: "C:/location" }, document.createElement("button"), 1, () => false);
  const button = state.column.querySelector("button");
  assert.ok(button.classList.contains("inert"));
  assert.equal(button.textContent.includes("open in Vidar"), true);
  button.click();
  assert.equal(state.calls.length, 0);
  assert.equal(state.refreshCalls, 1);
  assert.deepEqual(state.refreshRowsAtCall, [0]);
});
