// Resume list: cached for one launcher opening (reset on close), latest open wins when replies
// arrive out of order, and a double click on one row spawns once.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const rc = { cols: [], placed: 0, spawns: [] };
globalThis.__rc = rc;
const dom = setupDom({ stubs: {
  "panels/sessions": "export const openRenderedSessionIds = () => [];",
  "panels/sessions/zoom": "export function showSessionsToast() {}",
  "launcher/menu": "export const newBtn = document.createElement('button'); export function openLauncher() {}",
  "launcher/columns": `export function openColumn(depth) {
      const d = (globalThis.__rc.cols[depth] ??= document.createElement("div"));
      d.classList.remove("hidden"); d.innerHTML = ""; return d;
    }
    export function placeColumn() { globalThis.__rc.placed++; }`,
  "launcher/roster": `export const agentKind = () => "claude"; export const launcherTypes = []; export const variantsOf = new Map();
    export const shownRoots = () => []; export const shownVariants = () => [];
    export function spawnFrom(...a) { globalThis.__rc.spawns.push(a); return Promise.resolve("tab"); }`,
  "launcher/codex-recent": "export async function openCodexRecent() {}",
  "launcher/workspaces": "export const workspaces = [];",
  "launcher/menu-rows": `export function twoLineRow(parent, label, sub, title) {
      const b = document.createElement("button"); b.textContent = label;
      const s = document.createElement("span"); s.className = "launcher-sub-line"; s.textContent = sub;
      b.appendChild(s); parent.appendChild(b); return b;
    }`,
} });
const { openRecent } = await import("../src/launcher/recent.ts");
const { resetRecentCache } = await import("../src/launcher/recent-cache.ts");

const t = { id: "claude", label: "Claude", body: "raw" };
const rendered = { id: "claude", label: "Claude", body: "rendered" };
const anchor = document.createElement("button");
const session = (id) => ({ sessionId: id, label: `Session ${id}`, cwd: "C:\\w", ageSecs: 5, live: false, note: null });
const count = () => dom.ipc.invoked.filter((c) => c === "list_recent_sessions").length;

test("one list per key per opening; a reset refetches", async () => {
  resetRecentCache();
  dom.ipc.answers.list_recent_sessions = () => [session("a")];
  const loc = { label: "W", cwd: "C:\\w" };
  await openRecent(t, rendered, loc, anchor, 2);
  const again = openRecent(t, rendered, loc, anchor, 2);
  assert.ok(!rc.cols[2].textContent.includes("Loading"), "a settled hit renders without Loading…");
  assert.equal(rc.cols[2].querySelectorAll("button").length, 1, "rows are built synchronously");
  await again;
  assert.equal(count(), 1);
  resetRecentCache();
  await openRecent(t, rendered, loc, anchor, 2);
  assert.equal(count(), 2);
});

test("replies resolved out of order leave the later call's rows", async () => {
  resetRecentCache();
  const pending = {};
  dom.ipc.answers.list_recent_sessions = (args) => new Promise((r) => { pending[args.cwd] = r; });
  const first = openRecent(t, rendered, { label: "A", cwd: "C:\\a" }, anchor, 2);
  const second = openRecent(t, rendered, { label: "B", cwd: "C:\\b" }, anchor, 2);
  pending["C:\\b"]([session("bbbbbbbb")]);
  await second;
  pending["C:\\a"]([session("aaaaaaaa")]);
  await first;
  const rows = [...rc.cols[2].querySelectorAll("button")].map((b) => b.firstChild.textContent);
  assert.deepEqual(rows, ["Session bbbbbbbb"]);
});

test("two clicks on one row spawn once", async () => {
  resetRecentCache();
  rc.spawns.length = 0;
  let release;
  dom.ipc.answers.list_recent_sessions = () => [session("cccccccc")];
  dom.ipc.answers.read_session_meta = () => new Promise((r) => { release = r; });
  await openRecent(t, rendered, { label: "C", cwd: "C:\\c" }, anchor, 2);
  const row = rc.cols[2].querySelector("button");
  row.click();
  row.click();
  assert.equal(row.querySelector(".launcher-sub-line").textContent, "Opening…");
  release({ model: null, effort: null });
  await dom.flush();
  await dom.flush();
  assert.equal(rc.spawns.length, 1);
});
