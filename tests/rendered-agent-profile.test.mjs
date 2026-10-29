// Each Rendered agent states every profile field, and toolClass classifies every built-in tool
// name the adapters emit (no "other" for a known built-in).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { AGENT_PROFILE } = await import("../src/agents/agent-profile.ts");
const { toolClass } = await import("../src/panels/rendered/tool-class.ts");

const FIELDS = ["label", "newAdapter", "permissionModes", "resumeNoun", "inProcess", "falconHosted",
  "effortLevels", "modelMenu", "localCommands", "askUserQuestion", "subagents", "resumeCommand", "loginTip", "loginCheck",
  "modeLabels", "settlesOnSend", "stagedLocally", "groupModels", "perModelEffort", "busyBlocksEffort", "busyBlocksMode",
  "clampEffort", "commandCabinet", "beforeSpawn", "refusesHeldResume", "trustOffer", "sendsRulesFile",
  "namesAgentOnWire", "sendsGateway", "saveModels"];

test("every agent row is complete and builds an adapter", () => {
  assert.deepEqual(Object.keys(AGENT_PROFILE).sort(), ["claude", "codex"]);
  for (const [agent, p] of Object.entries(AGENT_PROFILE)) {
    assert.deepEqual(Object.keys(p).sort(), [...FIELDS].sort(), agent);
    for (const k of FIELDS) assert.notEqual(p[k], undefined, `${agent}.${k}`);
    assert.equal(typeof p.newAdapter().encodeUser, "function", agent);
    assert.ok(p.permissionModes.includes("default"), agent);
  }
});

test("spawn hooks are pinned per agent", () => {
  const { claude, codex } = AGENT_PROFILE;
  assert.equal(claude.beforeSpawn, null);
  assert.equal(typeof codex.beforeSpawn, "function");
  assert.deepEqual([claude.refusesHeldResume, codex.refusesHeldResume], [false, true]);
  assert.deepEqual([claude.trustOffer, codex.trustOffer], [false, true]);
  assert.deepEqual([claude.sendsRulesFile, codex.sendsRulesFile], [true, false]);
  assert.deepEqual([claude.namesAgentOnWire, codex.namesAgentOnWire], [false, true]);
  assert.deepEqual([claude.sendsGateway, codex.sendsGateway], [true, false]);
});

test("saveModels: Claude saves any non-empty list, Codex only a complete one, each under its own pref", async () => {
  const { getPref } = await import("../src/prefs.ts");
  const rows = [{ value: "a", label: "A", resolved: "a-1", effortLevels: ["low"] }];
  const { claude, codex } = AGENT_PROFILE;
  claude.saveModels([], false);
  assert.equal(getPref("claudeModels")?.length ?? 0, 0);
  claude.saveModels(rows, true);
  assert.deepEqual(getPref("claudeModels"), [{ value: "a", label: "A", resolved: "a-1" }]);
  codex.saveModels(rows, true);
  codex.saveModels([], false);
  assert.equal(getPref("codexModels")?.length ?? 0, 0);
  codex.saveModels(rows, false);
  assert.deepEqual(getPref("codexModels"), [{ value: "a", label: "A", effortLevels: ["low"] }]);
});

test("seededModels keeps Codex's picker session-only", async () => {
  const { seededModels } = await import("../src/panels/rendered/events.ts");
  assert.deepEqual(seededModels("codex"), []);
});

test("toolClass maps every built-in tool the adapters emit", () => {
  const claude = { Read: "read", Grep: "search", Glob: "search", Edit: "edit", Write: "edit", NotebookEdit: "edit",
    Bash: "run", PowerShell: "run", WebFetch: "web", WebSearch: "web", AskUserQuestion: "ask", Agent: "agent",
    Task: "agent", Thought: "think", mcp__srv__tool: "other", TodoWrite: "other" };
  for (const [n, c] of Object.entries(claude)) assert.equal(toolClass(n, "claude"), c, `claude ${n}`);
  const codex = { Command: "run", Edit: "edit", WebSearch: "web", Thought: "think", "srv.tool": "other", item: "other" };
  for (const [n, c] of Object.entries(codex)) assert.equal(toolClass(n, "codex"), c, `codex ${n}`);
  assert.equal(toolClass("toString", "claude"), "other");
});
