import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

globalThis.__workspaceRows = [{ label: "Work", cwd: "C:\\Work", sets: [{ library: "toolkit", set: "toolkit" }] }];
setupDom({ stubs: {
  "launcher/workspaces": `export const workspaces = globalThis.__workspaceRows;
    export function folderName(cwd) { return cwd.split("\\\\").pop(); }
    export async function pickFolder() { return null; }
    export async function saveWorkspaces() { throw new Error("unexpected save"); }`,
  "settings/modal": `export const REVERT_EVENT = "revert";`,
  "settings/live-list": `export function isRedrawing() { return false; }
    export function redraw(root, draw) { root.replaceChildren(); draw(); }`,
  "settings/registry": `export function registerCategory() {}
    export function addSettingRow(row) { globalThis.__settingRow = row; }`,
} });

const { registerWorkspaceRows } = await import("../src/settings/workspaces.ts");

test("saved workspace sets do not expose an add-on editor", () => {
  registerWorkspaceRows();
  const root = globalThis.__settingRow.control(() => {});
  assert.equal(root.querySelectorAll(".ws-row").length, 1);
  assert.equal(root.querySelector('[aria-label="Add-On Sets"]'), null);
  assert.deepEqual([...root.querySelectorAll(".ws-row button")].map((b) => b.textContent), ["Browse", "Remove"]);
});
