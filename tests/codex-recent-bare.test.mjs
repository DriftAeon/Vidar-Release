// The Codex Resume list (launcher codex-recent.ts): the Rendered Bare row passes its profile so
// list_codex_threads (codex_threads.rs) reads the Bare home; the default row passes none. A body's
// /resume row choice is recent-resume-variant.test.mjs. No CLI or host is started; IPC
// and sessions are stubs.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const seen = [];
const dom = setupDom({
  stubs: {
    "panels/sessions": `export async function createSession() { return "s1"; }
      export function hasArmedAstra() { return false; }
      export function codexThreadHolder() { return null; }
      export async function refreshRawCodexThreads() {}`,
    "tab-names": "export function mintTabName() { return 'Tab'; }",
    "capabilities/registry": "export function use() { return null; }",
  },
  answers: { list_codex_threads: (a) => { seen.push(a); return []; } },
});

const { BUILTIN_AGENTS, setRoster, rosterView } = await import("../src/launcher/roster.ts");
const { openCodexRecent } = await import("../src/launcher/codex-recent.ts");

setRoster(BUILTIN_AGENTS);
const { variantsOf, launcherTypes } = rosterView();
// BUILTIN_AGENTS holds the plain rows too: the plain Rendered variant hangs off the plain root, the
// Bare one off the Bare root (roster.ts resolveAgents)
const codex = launcherTypes.find((t) => t.key === "codex-bare");
const variants = [...(variantsOf.get(launcherTypes.find((t) => t.key === "codex")) ?? []), ...(variantsOf.get(codex) ?? [])];
const byKey = (k) => variants.find((v) => v.key === k);
const LOC = { label: "Work", cwd: "C:\\work" };

test("openCodexRecent: the Bare row lists with its profile; the default row passes none", async () => {
  assert.ok(byKey("codex-rendered-bare"), "the Bare row is in the Codex Bare flyout");
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const calls = () => dom.ipc.invoked.filter((c) => c === "list_codex_threads").length;
  await openCodexRecent(codex, byKey("codex-rendered-bare"), LOC, anchor, 2, () => false);
  assert.equal(calls(), 1);
  assert.deepEqual(seen.at(-1), { cwd: LOC.cwd, profile: "bare" });
  await openCodexRecent(codex, byKey("codex-rendered"), LOC, anchor, 2, () => false);
  assert.equal(calls(), 2);
  assert.deepEqual(seen.at(-1), { cwd: LOC.cwd, profile: undefined });
});
