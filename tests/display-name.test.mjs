import test from "node:test";
import assert from "node:assert/strict";

const { shownName } = await import("../src/panels/display-name.ts");

test("shownName strips a date prefix", () => {
  assert.equal(shownName("2026-10-02-spawn-card.md"), "spawn-card.md");
});

test("shownName strips a date and time prefix", () => {
  assert.equal(shownName("2026-10-03-1654-x.md"), "x.md");
});

test("shownName leaves unprefixed names alone", () => {
  assert.equal(shownName("notes.md"), "notes.md");
});

test("shownName keeps a prefix-only name", () => {
  assert.equal(shownName("2026-10-02-.md"), "2026-10-02-.md");
});

test("prettyName drops the extension, splits on - and _, capitalises, upper-cases acronyms", async () => {
  const { prettyName } = await import("../src/panels/display-name.ts");
  assert.equal(prettyName("mcp-flow-test-mock.html"), "MCP Flow Test Mock");
  assert.equal(prettyName("2026-10-02-spawn_card.md"), "Spawn Card");
});
