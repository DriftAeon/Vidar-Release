// Skill, agent and hook file rows show a Title Case name from the file (src/runes/bare/row-name.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { fileName, isFileRow } from "../src/runes/bare/row-name.ts";

test("fileName: extension dropped, split on - and _, Title Case with small words lowercase after the first", () => {
  assert.equal(fileName("C:\\Users\\example-user\\.claude\\hooks\\guard-install.mjs"), "Guard Install");
  assert.equal(fileName("C:\\Users\\example-user\\.claude\\skills\\adversarial-diff-review"), "Adversarial Diff Review");
  assert.equal(fileName("C:/h/agents/Striker-O.md"), "Striker O");
  assert.equal(fileName("C:/h/skills/state_of_the_art/SKILL.md"), "State of the Art");
  assert.equal(fileName("C:/h/skills/of-note"), "Of Note");
});

test("isFileRow: only skill, agent and hook rows; rune rows keep their own names", () => {
  for (const kind of ["skill", "agent", "hook"]) assert.equal(isFileRow({ kind }), true);
  for (const kind of ["rules", "memory", "mcp"]) assert.equal(isFileRow({ kind }), false);
});
