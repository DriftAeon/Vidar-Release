// Left-bar row text: model display names and tab-title Title Case (display only).
import test from "node:test";
import assert from "node:assert/strict";
import { modelRowName } from "../src/format.ts";
import { tabTitleCase } from "../src/panels/sessions/tab-state-format.ts";

test("modelRowName: ids and aliases read as display names", () => {
  const cases = [
    ["sonnet-5.5", "Sonnet 5.5"],
    ["claude-sonnet-5-5", "Sonnet 5.5"],
    ["opus-5.5", "Opus 5.5"],
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["haiku-4-5", "Haiku 4.5"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["fable-5.1", "Fable 5.1"],
    ["gpt-5.4-codex", "GPT-5.4 Codex"],
    ["opus[1m]", "Opus 1M"],
    ["claude-opus-5-5[1m]", "Opus 5.5 1M"],
    ["some_new-model", "Some New Model"],
    ["some-model-7", "Some 7 Model"],
    ["", ""],
  ];
  for (const [id, want] of cases) assert.equal(modelRowName(id), want, id);
});

test("modelRowName: idempotent on its own output", () => {
  for (const n of ["Sonnet 5.5", "GPT-5.4 Codex", "Opus 5.5 1M", "Haiku 4.5"]) assert.equal(modelRowName(n), n);
});

test("tabTitleCase: words capitalised, short words lower except first", () => {
  assert.equal(tabTitleCase("fix the bar"), "Fix the Bar");
  assert.equal(tabTitleCase("the end of it"), "The End of It");
  assert.equal(tabTitleCase("notes for the user"), "Notes for the User");
});

test("tabTitleCase: capitals, digits, dots, slashes and colons stay as typed", () => {
  assert.equal(tabTitleCase("H2 rows in leftbar.css"), "H2 Rows in leftbar.css");
  assert.equal(tabTitleCase("check X:\\work now"), "Check X:\\work Now");
  assert.equal(tabTitleCase("src/panels and iPhone"), "src/panels and iPhone");
  assert.equal(tabTitleCase("Session 3"), "Session 3");
});

test("tabTitleCase: whitespace is preserved", () => {
  assert.equal(tabTitleCase("a  b"), "A  B");
});
