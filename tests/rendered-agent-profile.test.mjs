// Each Rendered agent states every profile field, and toolClass classifies every built-in tool
// name the adapters emit (no "other" for a known built-in).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { AGENT_PROFILE } = await import("../src/panels/rendered/agent-profile.ts");
const { toolClass } = await import("../src/panels/rendered/tool-class.ts");

const FIELDS = ["label", "newAdapter", "permissionModes", "resumeNoun", "inProcess", "falconHosted",
  "effortLevels", "modelMenu", "localCommands", "askUserQuestion", "subagents", "resumeCommand", "loginTip", "loginCheck",
  "modeLabels", "settlesOnSend", "stagedLocally", "groupModels", "perModelEffort", "busyBlocksEffort", "busyBlocksMode",
  "clampEffort", "commandCabinet"];

test("every agent row is complete and builds an adapter", () => {
  assert.deepEqual(Object.keys(AGENT_PROFILE).sort(), ["claude", "codex"]);
  for (const [agent, p] of Object.entries(AGENT_PROFILE)) {
    assert.deepEqual(Object.keys(p).sort(), [...FIELDS].sort(), agent);
    for (const k of FIELDS) assert.notEqual(p[k], undefined, `${agent}.${k}`);
    assert.equal(typeof p.newAdapter().encodeUser, "function", agent);
    assert.ok(p.permissionModes.includes("default"), agent);
  }
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
