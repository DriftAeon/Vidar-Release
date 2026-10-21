// The primary agent (vidar.json `primaryAgent`): the resolver over active agent modules, and the
// three consumers that read it at use time (launcher root order, setup order, the Falcon row's parent).
import test from "node:test";
import assert from "node:assert/strict";
import {
  choicesOf, effectivePrimary, primaryAsked, primaryChoices, resolvePrimary, setPrimarySources,
} from "../src/agents/primary.ts";
import { falconRowParent, offModuleKeys, orderRoots, setPrimaryRootSource } from "../src/launcher/roster-shown.ts";
import { missingSetupAgentMessage, pickSetupRunner } from "../src/deps/setup-prompt.ts";

const CLAUDE = { id: "claude", kind: "agent", label: "Claude", agent: { setup: { dep: "claude", order: 0 } } };
const CODEX = { id: "codex", kind: "agent", label: "Codex", agent: { setup: { dep: "codex", order: 1 } } };
const GEMINI = { id: "gemini", kind: "agent", label: "Gemini", agent: {} };
// codex listed ahead of claude, so setup order (not list order) has to decide
const BOTH = [CODEX, GEMINI, CLAUDE];

test("resolver: a saved pick whose module is active wins", () => {
  assert.equal(resolvePrimary("codex", BOTH), "codex");
  assert.equal(resolvePrimary("claude", BOTH), "claude");
});

test("resolver: a saved pick that is not active falls back to the other agent", () => {
  assert.equal(resolvePrimary("codex", [CLAUDE]), "claude");
  assert.equal(resolvePrimary("claude", [CODEX, GEMINI]), "codex");
});

test("resolver: unset with both active is setup order (Claude), so nothing moves for a user who never picks", () => {
  assert.equal(resolvePrimary(undefined, BOTH), "claude");
  assert.equal(resolvePrimary(null, BOTH), "claude");
  assert.equal(resolvePrimary("gemini", BOTH), "claude", "an invalid hand edit reads as unset");
  assert.equal(resolvePrimary(undefined, [CODEX]), "codex");
});

test("resolver: unset in a codex-only set is Codex, with or without other agents; both shipped keeps Claude", () => {
  assert.equal(resolvePrimary(undefined, [CODEX]), "codex");
  assert.equal(resolvePrimary(undefined, [GEMINI, CODEX]), "codex");
  assert.equal(resolvePrimary("claude", [CODEX]), "codex", "a saved Claude that is off never wins");
  assert.equal(resolvePrimary(undefined, [CLAUDE]), "claude");
  assert.equal(resolvePrimary(undefined, [CODEX, CLAUDE]), "claude");
  assert.deepEqual(choicesOf([CODEX]), ["codex"]);
});

test("Settings rows: keyed rows of an off agent module are listed for hiding, custom rows never", () => {
  const rows = [
    { key: "claude", id: "claude" }, { key: "claude-bare", id: "claude", under: "claude" },
    { key: "codex", id: "codex" }, { key: "astra", id: "codex", under: "codex" },
    { key: "terminal", id: "shell" }, { id: "claude", label: "Mine" },
  ];
  const ids = new Set(["claude", "codex"]);
  assert.deepEqual([...offModuleKeys(rows, ids, (id) => id === "codex")].sort(), ["claude", "claude-bare"]);
  assert.deepEqual([...offModuleKeys(rows, ids, () => true)], []);
});

test("resolver: none active is null, saved or not", () => {
  assert.equal(resolvePrimary(undefined, []), null);
  assert.equal(resolvePrimary("codex", [GEMINI]), null);
  assert.equal(resolvePrimary("claude", []), null);
});

test("choices are the active agents in setup order; asked means the key is present", () => {
  assert.deepEqual(choicesOf(BOTH), ["claude", "codex"]);
  assert.deepEqual(choicesOf([GEMINI, CODEX]), ["codex"]);
  let saved;
  let active = BOTH;
  setPrimarySources(() => saved, () => active);
  assert.equal(primaryAsked(), false);
  assert.equal(effectivePrimary(), "claude");
  saved = "codex";
  assert.equal(primaryAsked(), true);
  assert.equal(effectivePrimary(), "codex");
  saved = "Codex";
  assert.equal(primaryAsked(), false);
  saved = "codex";
  active = [CLAUDE];
  assert.equal(effectivePrimary(), "claude");
  assert.deepEqual(primaryChoices(), ["claude"]);
  setPrimarySources(() => undefined, () => []);
});

test("roster: the primary's root leads Claude/Codex by default; a saved order still wins", () => {
  const claude = { key: "claude", id: "claude" };
  const codex = { key: "codex", id: "codex" };
  const gemini = { key: "gemini", id: "gemini" };
  const terminal = { key: "terminal", id: "shell" };
  const roots = [terminal, gemini, claude, codex];
  try {
    setPrimaryRootSource(() => null);
    assert.deepEqual(orderRoots(roots, undefined), [claude, codex, gemini, terminal]);
    setPrimaryRootSource(() => "codex");
    assert.deepEqual(orderRoots(roots, undefined), [codex, claude, gemini, terminal]);
    assert.deepEqual(orderRoots(roots, ["terminal", "claude", "codex"]), [terminal, claude, codex, gemini]);
    // a saved order naming neither leaves the pair in primary order behind it
    assert.deepEqual(orderRoots(roots, ["gemini"]), [gemini, codex, claude, terminal]);
    setPrimaryRootSource(() => "claude");
    assert.deepEqual(orderRoots(roots, undefined), [claude, codex, gemini, terminal]);
  } finally {
    setPrimaryRootSource(() => null);
  }
});

test("setup: the primary runs setup first, then setup order", () => {
  const found = { deps: [{ id: "claude", found: true, location: "C:\\bin\\claude.exe" }, { id: "codex", found: true, location: "C:\\bin\\codex.cmd" }] };
  assert.equal(pickSetupRunner(BOTH, found).id, "claude");
  assert.equal(pickSetupRunner(BOTH, found, null).id, "claude");
  assert.equal(pickSetupRunner(BOTH, found, "codex").id, "codex");
  const codexMissing = { deps: [found.deps[0], { id: "codex", found: false }] };
  assert.equal(pickSetupRunner(BOTH, codexMissing, "codex").id, "claude", "a primary that cannot run falls through");
  const deps = [{ id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex CLI" }];
  assert.equal(missingSetupAgentMessage(BOTH, deps), "No Setup Agent Found: Install Claude Code Or Codex CLI, Then Recheck");
  assert.equal(missingSetupAgentMessage(BOTH, deps, "codex"), "No Setup Agent Found: Install Codex CLI Or Claude Code, Then Recheck");
});

test("Falcon row: under the primary's root, else the other shown one, never without Falcon", () => {
  assert.equal(falconRowParent("claude", ["claude", "codex"], true), "claude");
  assert.equal(falconRowParent("codex", ["claude", "codex"], true), "codex");
  assert.equal(falconRowParent(null, ["claude", "codex"], true), "claude");
  assert.equal(falconRowParent("claude", ["codex", "shell"], true), "codex", "Claude root hidden");
  assert.equal(falconRowParent("codex", ["claude"], true), "claude");
  assert.equal(falconRowParent("codex", ["shell"], true), null);
  assert.equal(falconRowParent("codex", ["claude", "codex"], false), null);
});
