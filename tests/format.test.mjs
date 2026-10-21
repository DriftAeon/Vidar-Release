// prettyModel: known-id table plus idempotency.
import test from "node:test";
import assert from "node:assert/strict";
import { prettyModel, prettyTool, toolWords, titleWords, label } from "../src/format.ts";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom(); // installs the extensionless-import hook rendered/format.ts needs
const { commandInputText, commandScript, toolSummary } = await import("../src/panels/rendered/format.ts");

test("titleWords and label read UE and LLM as acronyms", () => {
  assert.equal(titleWords("rider_ue_health"), "Rider UE Health");
  assert.equal(titleWords("local-llm"), "Local LLM");
  assert.equal(titleWords("vidar-drive"), "Vidar Drive");
  assert.equal(`Proxy for ${label("ue")}`, "Proxy for UE");
  assert.equal(label("llm"), "LLM");
});

test("prettyTool splits camelCase MCP tool names", () => {
  assert.equal(prettyTool("mcp__atlassian__executeRead"), "Atlassian: Execute Read");
  assert.equal(prettyTool("mcp__atlassian__getAccessibleAtlassianResources"), "Atlassian: Get Accessible Atlassian Resources");
  assert.equal(prettyTool("mcp__playwright__browser_click"), "Playwright: Browser Click");
  assert.equal(toolWords("executeRead"), "Execute Read");
});

const TABLE = [
  ["claude-fable-5-1", "Fable 5.1"],
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-opus-5", "Opus 5"],
  ["claude-sonnet-5", "Sonnet 5"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5"],
  ["gpt-5.6-terra", "GPT-5.6 Terra"],
  ["gpt-6-astra", "GPT-6 Astra"],
];

test("prettyModel: known ids map to their display name", () => {
  for (const [id, pretty] of TABLE) {
    assert.equal(prettyModel(id), pretty);
  }
});

test("prettyModel: heuristic formats an unlisted id", () => {
  assert.equal(prettyModel("opus[1m]"), "Opus 1M");
});

test("prettyModel: idempotent on every known pretty name", () => {
  for (const [, pretty] of TABLE) {
    assert.equal(prettyModel(pretty), pretty);
  }
});

test("prettyModel: idempotent on the GPT-5.6 Terra name specifically", () => {
  assert.equal(prettyModel("GPT-5.6 Terra"), "GPT-5.6 Terra");
});

test("toolSummary: an ask pill shows the header, falling back to Question", () => {
  const ask = (q) => toolSummary("AskUserQuestion", { questions: [q] });
  assert.equal(ask({ question: "Which db?", header: "Database" }), "Database");
  assert.equal(ask({ question: "Which db?" }), "Question");
  assert.equal(ask({ question: "Which db?", header: "  " }), "Question");
  assert.equal(toolSummary("AskUserQuestion", {}), "Question");
});

test("Command display extracts a PowerShell script while retaining its exact invocation and cwd", () => {
  const input = {
    command: `C:\\Program Files\\PowerShell\\7\\pwsh.exe -NoLogo -NoProfile -Command Write-Output 'hello'`,
    cwd: "D:\\Work\\Project",
  };
  assert.equal(commandScript(input), "Write-Output 'hello'");
  assert.equal(toolSummary("Command", input), "Write-Output 'hello'");
  const shown = commandInputText(input);
  assert.match(shown, /Script:\nWrite-Output 'hello'/);
  assert.match(shown, /Working Directory:\nD:\\Work\\Project/);
  assert.ok(shown.endsWith(`Full Invocation:\n${input.command}`));
});

test("Command display removes only the outer PowerShell script quotes", () => {
  const input = { command: '"C:\\Windows\\pwsh.exe" -Command "Get-Content -LiteralPath runtime\\state.json; rg -n \'status\' src"' };
  assert.equal(commandScript(input), "Get-Content -LiteralPath runtime\\state.json; rg -n 'status' src");
  assert.equal(toolSummary("Command", input), "Get-Content -LiteralPath runtime\\state.json; rg -n 'status' src");
});

test("Command display leaves non-PowerShell invocations intact", () => {
  assert.equal(commandScript({ command: "git status --short" }), "git status --short");
});
