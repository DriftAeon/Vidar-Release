import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const loadout = {
  instructions: [],
  memoryPath: "C:\\Users\\case\\.claude\\projects\\work\\memory\\MEMORY.md",
  memoryEntries: 3,
  handoffPath: "C:\\Users\\case\\.claude\\handoffs\\work",
  handoffNewest: "C:\\Users\\case\\.claude\\handoffs\\work\\latest.md",
  skills: [], agents: [], notes: [],
  hooks: [
    { path: "C:\\Work\\.claude\\settings.json", events: [["PreToolUse", ["check.ps1", "check.ps1"]]] },
    { path: "C:\\Work\\.claude\\settings.local.json", events: [["PreToolUse", ["audit.mjs"]]] },
  ],
  permissions: [
    { path: "C:\\Work\\.claude\\settings.json", allow: 2, ask: ["Bash(git push:*)"], deny: ["Bash(rm:*)"] },
    { path: "C:\\Work\\.claude\\settings.local.json", allow: 1, deny: ["Read(.env)"] },
  ],
};

setupDom({
  stubs: {
    "panels/reorder": "export function applyOrder() {} export function enableReorder() {}",
    "modules/registry": "export const moduleOn = () => true; export const onModulesChange = () => () => {};",
  },
  answers: { read_loadout: loadout },
});
const { initLoadout } = await import("../src/panels/loadout.ts");

test("Loadout keeps disclosure controls while grouping memory, hooks and permissions", async () => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const controller = new window.AbortController();
  initLoadout(root, controller.signal);
  document.dispatchEvent(new window.CustomEvent("vidar-focus", {
    detail: { id: "test", agent: "claude", cwd: "C:\\Work", launchArgs: [] },
  }));
  await Promise.resolve();
  await Promise.resolve();

  const gear = root.querySelector(".loadout-gear");
  gear.click();
  assert.equal(gear.getAttribute("aria-expanded"), "true");

  const open = (key) => {
    const row = [...root.querySelectorAll(".rack-row")].find((el) => el.dataset.key === key);
    assert.ok(row, key);
    row.querySelector(".rack-name").click();
    assert.equal(row.querySelector(".rack-name").getAttribute("aria-expanded"), "true");
    return row.querySelector(".rack-detail");
  };

  const memory = open("Memory");
  assert.equal(memory.querySelectorAll(".loadout-info-line").length, 2);
  assert.match(memory.textContent, /~\\.claude\\projects/);
  assert.equal(memory.querySelector(".icn").title, "3 Memory Entries");

  const hooks = open("Hooks");
  assert.equal(hooks.querySelector(".loadout-group-head").textContent, "Pre Tool Use");
  assert.deepEqual([...hooks.querySelectorAll(".loadout-item-line")].map((el) => el.textContent), ["check.ps1 ×2", "audit.mjs"]);
  assert.match(hooks.querySelector(".loadout-item-line").title, /settings\.json/);

  const permissions = open("Permissions");
  assert.deepEqual([...permissions.querySelectorAll(".loadout-group-head")].map((el) => el.textContent), ["Allow", "Ask", "Deny"]);
  assert.deepEqual([...permissions.querySelectorAll(".loadout-source-line")].map((el) => el.lastElementChild.textContent), ["2", "1"]);
  assert.equal(permissions.querySelector(".loadout-source-line .loadout-ellipsis").textContent, ".\\.claude\\settings.json");
  assert.deepEqual([...permissions.querySelectorAll(".loadout-item-line:not(.loadout-source-line)")].map((el) => el.textContent), ["Bash(git push:*)", "Bash(rm:*)", "Read(.env)"]);
  assert.match(permissions.querySelectorAll(".loadout-item-line:not(.loadout-source-line)")[1].title, /settings\.json/);

  root.querySelector('[data-key="Hooks"] .rack-name').click();
  assert.equal(root.querySelector('[data-key="Hooks"] .rack-name').getAttribute("aria-expanded"), "false");

  controller.abort();
});
