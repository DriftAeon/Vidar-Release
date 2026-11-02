// Skill, agent and hook file rows show a Title Case name from the file (src/runes/bare/row-name.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { rowLabel, isFileRow, nameAndPath, idLabel } = await import("../src/runes/bare/row-name.ts");
const { libraryLabel } = await import("../src/runes/bare/gen-label.ts");

test("fileName (via an MCP row): extension dropped, split on - and _, Title Case with small words lowercase after the first", () => {
  const fileName = (shown) => rowLabel({ kind: "mcp", shown });
  assert.equal(fileName("C:\\Users\\example-user\\.claude\\hooks\\guard-install.mjs"), "Guard Install");
  assert.equal(fileName("C:\\Users\\example-user\\.claude\\skills\\adversarial-diff-review"), "Adversarial Diff Review");
  assert.equal(fileName("C:/h/agents/Striker-O.md"), "Striker O");
  assert.equal(fileName("C:/h/skills/state_of_the_art/SKILL.md"), "State of the Art");
  assert.equal(fileName("C:/h/skills/of-note"), "Of Note");
  assert.equal(fileName("openaiDeveloperDocs"), "Openai Developer Docs");
});

test("idLabel: set and library ids read in Title Case", () => {
  assert.equal(idLabel("team-mine"), "Team Mine");
  assert.equal(idLabel("vidar-recall"), "Vidar Recall");
  assert.equal(idLabel("team"), "Team");
  assert.equal(idLabel(""), "");
});

test("idLabel: known acronyms keep their capitals, other words are unchanged", () => {
  assert.equal(idLabel("mcp-extras"), "MCP Extras");
  assert.equal(idLabel("mcp-gate"), "MCP Gate");
  assert.equal(idLabel("ui"), "UI");
  assert.equal(idLabel("team-mine"), "Team Mine");
  assert.equal(idLabel("stdio-bridge"), "Stdio Bridge");
});

test("libraryLabel: a plain library id in Title Case, a generated one keeps its hyphen-joined name", () => {
  assert.equal(libraryLabel("team-mine"), "Team Mine");
  assert.equal(libraryLabel("gen-claude-bare-0123abcd"), "Runes-Claude-Bare-" + libraryLabel("gen-claude-bare-0123abcd").split("-").pop());
});

test("isFileRow: only skill, agent and hook rows; rune rows keep their own names", () => {
  for (const kind of ["skill", "agent", "hook"]) assert.equal(isFileRow({ kind }), true);
  for (const kind of ["rules", "memory", "mcp"]) assert.equal(isFileRow({ kind }), false);
});

test("raw hook rows show only their event, matcher and program label", () => {
  const row = { path: "C:/h/hooks.json#Stop:0:0:digest", shown: "Stop · * · pwsh", kind: "hook",
    guard: { event: "Stop", run: [], source: "0:0:digest" } };
  const parts = nameAndPath(row);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].textContent, "Stop · * · pwsh");
  assert.doesNotMatch(parts[0].textContent, /hooks\.json|digest/);
});
