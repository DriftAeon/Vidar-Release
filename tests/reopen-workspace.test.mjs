// reopen-workspace.ts: Open in Worktree and Refresh (reopenHere) pass the old tab's rune sets to
// spawnFrom as its pick; a tab without `sets` passes none. roster, sessions and workspaces are stubs.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const rig = { calls: [], closed: [] };
globalThis.__reopenRig = rig;
const dom = setupDom({
  answers: { vidar_worktree_open: "C:\\wt\\vidar" },
  stubs: {
    "launcher/roster": `const r = globalThis.__reopenRig;
      const row = { id: "claude", key: "claude-rendered-bare", body: "rendered", profile: "bare" };
      export function shownRoots() { return [row]; }
      export function shownVariants() { return []; }
      export async function spawnFrom(...args) { r.calls.push(args); return "s"; }`,
    "launcher/agent-kind": "export function agentKind() { return 'claude'; }",
    "launcher/workspaces": "export function folderName(p) { return p.split('\\\\').pop(); } export async function pickWorkspace() { return null; }",
    "panels/sessions": `export function closeSession(id) { globalThis.__reopenRig.closed.push(id); }`,
  },
});
void dom;

const { reopenHere, reopenInWorktree } = await import("../src/launcher/reopen-workspace.ts");

const tab = (extra) => ({ id: "t1", agent: "claude", rowKey: "claude-rendered-bare", cwd: "C:\\work\\repo", button: { dataset: {} }, ...extra });
const SETS = [{ set: "Base" }, { library: "Main", set: "vidar-recall" }];

test("reopenInWorktree and reopenHere pass the tab's sets as the pick", async () => {
  rig.calls.length = 0;
  await reopenInWorktree(tab({ sets: SETS }));
  await reopenHere(tab({ sets: SETS }), true);
  assert.equal(rig.calls.length, 2);
  for (const c of rig.calls) assert.deepEqual(c[6], SETS);
});

test("a tab without sets spawns with no pick", async () => {
  rig.calls.length = 0;
  await reopenInWorktree(tab());
  await reopenHere(tab(), false);
  assert.equal(rig.calls.length, 2);
  for (const c of rig.calls) assert.equal(c[6], undefined);
});
