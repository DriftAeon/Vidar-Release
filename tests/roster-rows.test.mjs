// The eight per-agent launcher rows (launcher/row-facts.ts) pinned verbatim: keys, order and fields
// are the vidar.json overlay identity (match by `key`), so a table edit must not move them silently.
import test from "node:test";
import assert from "node:assert/strict";
import { ALL_ROWS, ROW_FACTS, rowsFor } from "../src/launcher/row-facts.ts";
import { AGENT_IDS } from "../src/agents/id.ts";

const PLAIN = ["-NoExit", "-Command"];

test("every full agent has a facts row and four launcher rows", () => {
  assert.deepEqual(Object.keys(ROW_FACTS), [...AGENT_IDS]);
  assert.equal(ALL_ROWS.length, AGENT_IDS.length);
});

test("the eight roster rows are pinned", () => {
  const flat = ALL_ROWS.flatMap((r) => [r.bare, r.bareRendered, r.plain, r.plainRendered]);
  assert.equal(JSON.stringify(flat), JSON.stringify([
    { key: "claude-bare", id: "claude", label: "Claude", profile: "bare", requires: ["claude"] },
    { key: "claude-rendered-bare", id: "claude", label: "Rendered", under: "claude", body: "rendered", profile: "bare", permissionMode: "auto", requires: ["claude", "node", "falcon"] },
    { key: "claude", id: "claude", label: "Plain", requires: ["claude"], args: [...PLAIN, "claude"] },
    { key: "claude-rendered", id: "claude", label: "Plain Rendered", under: "claude", body: "rendered", permissionMode: "auto", requires: ["claude", "node", "falcon"] },
    { key: "codex-bare", id: "codex", label: "Codex", profile: "bare", requires: ["codex", "node"] },
    { key: "codex-rendered-bare", id: "codex", label: "Rendered", under: "codex", body: "rendered", profile: "bare", requires: ["codex", "node"] },
    { key: "codex", id: "codex", label: "Plain", requires: ["codex"], args: [...PLAIN, "codex"] },
    { key: "codex-rendered", id: "codex", label: "Plain Rendered", under: "codex", body: "rendered", permissionMode: "default", requires: ["codex", "node"] },
  ]));
});

test("rowsFor returns fresh arrays, so an overlay edit never reaches the table", () => {
  const a = rowsFor("claude");
  a.bare.requires.push("x");
  assert.deepEqual(rowsFor("claude").bare.requires, ["claude"]);
});
