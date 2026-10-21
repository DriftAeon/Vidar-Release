// setupAgentBlocker counts required misses only (C8, 2026-10-15): an optional row the user never
// installed (an agent CLI, Git) does not enable Setup Via Agent, and a Codex-only user is never
// told to install Claude. The module registry and the primary agent are stubbed; deps/state is real.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const codex = { id: "codex", kind: "agent", label: "Codex", agent: { setup: { dep: "codex", order: 1 } } };
globalThis.__setupAgents = [codex];
const dom = setupDom({
  stubs: {
    "modules/registry": "export function modulesOf() { return globalThis.__setupAgents; }",
    "agents/primary": 'export function effectivePrimary() { return "codex"; }',
  },
});

const state = await import("../src/deps/state.ts");
const { setupAgentBlocker } = await import("../src/deps/setup-agent.ts");

/** Detect against the static catalog plus a codex row; `missing` ids read not found. */
async function detect(...missing) {
  const rows = state.CATALOG.deps.map((d) => ({ id: d.id, found: !missing.includes(d.id) }));
  rows.push(missing.includes("codex") ? { id: "codex", found: false } : { id: "codex", found: true, location: "C:\\npm\\codex.cmd" });
  dom.ipc.answers.detect_dependencies = { root: "C:\\V", deps: rows };
  assert.ok(await state.loadDeps(), "loadDeps resolved null");
}

test("only optional rows missing: nothing for Setup to do", async () => {
  const optional = state.CATALOG.deps.filter((d) => !d.required).map((d) => d.id);
  assert.ok(optional.includes("git"), "catalog has no optional git row");
  await detect("git", "claude", ...optional);
  assert.equal(setupAgentBlocker(), "Nothing Required Missing");
});

test("a required miss with Codex found enables Setup", async () => {
  const required = state.CATALOG.deps.find((d) => d.required);
  await detect(required.id, "git");
  assert.equal(setupAgentBlocker(), null);
});

test("a Codex-only user with no runner is told to install Codex, never Claude", async () => {
  const required = state.CATALOG.deps.find((d) => d.required);
  await detect(required.id, "codex");
  const message = setupAgentBlocker();
  assert.match(message, /^No Setup Agent Found: Install Codex, Then Recheck$/);
  assert.doesNotMatch(message, /Claude/);
});
