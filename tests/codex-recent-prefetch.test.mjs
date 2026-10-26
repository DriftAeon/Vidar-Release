// The Codex Resume reads start when the agent column opens (prefetchCodexRecent) and Resume
// shares them: one list fetch and one held-thread refresh per opening, even with Resume opened
// while the first is still in flight.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const state = { listCalls: 0, refreshCalls: 0, release: null, column: null };
globalThis.__codexPrefetch = state;
setupDom({ answers: { list_codex_threads: () => { state.listCalls++; return new Promise((r) => { state.release = () => r([]); }); } }, stubs: {
  "panels/sessions": `export const codexThreadHolder = () => null;
    export async function refreshRawCodexThreads() { globalThis.__codexPrefetch.refreshCalls++; }`,
  "launcher/columns": "export const openColumn = () => globalThis.__codexPrefetch.column; export function placeColumn() {} export function hoverOpen() {}",
  "launcher/roster": "export async function spawnFrom() {}",
} });
const { openCodexRecent, prefetchCodexRecent } = await import("../src/launcher/codex-recent.ts");
const { resetRecentCache } = await import("../src/launcher/recent-cache.ts");
const rendered = { id: "codex", body: "rendered" };
const loc = { label: "Work", cwd: "C:/location" };

test("one column open fetches once; Resume opened mid-flight starts no second fetch", async () => {
  resetRecentCache();
  state.column = document.createElement("div");
  prefetchCodexRecent(rendered, loc);
  prefetchCodexRecent(rendered, loc);
  assert.equal(state.listCalls, 1);
  assert.equal(state.refreshCalls, 1);
  const opening = openCodexRecent(rendered, rendered, loc, document.createElement("button"), 1, () => false);
  assert.equal(state.listCalls, 1);
  state.release();
  await opening;
  assert.equal(state.listCalls, 1);
  assert.equal(state.refreshCalls, 1);
});

test("Resume after a settled prefetch renders without a second fetch", async () => {
  resetRecentCache();
  state.listCalls = 0; state.refreshCalls = 0;
  state.column = document.createElement("div");
  prefetchCodexRecent(rendered, loc);
  state.release();
  await new Promise((r) => setTimeout(r, 10));
  await openCodexRecent(rendered, rendered, loc, document.createElement("button"), 1, () => false);
  assert.equal(state.listCalls, 1);
  assert.equal(state.refreshCalls, 1);
});
