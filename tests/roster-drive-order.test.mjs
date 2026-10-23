// Ordering: initDrive runs in main.ts before the config lands and setRoster replaces the
// roster bindings, so drive must read the roster at call time, not hold the value it got at init.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "panels/sessions": `export function createSession() {} export function hasArmedAstra() { return false; }
      export function driveSnapshot() { return { tabs: [] }; } export const renderedDrive = {};
      export function sessionContainer() { return null; } export function writeToSession() {}`,
    "settings/registry": "export function getRegistry() { return {}; }",
    "deps/state": "export function isAvailable() { return true; } export function depFound() { return true; }",
    "modules/registry": "export function moduleViews() { return []; }",
    "capabilities/registry": "export function use() {}",
    "launcher/vidar-path": "export async function resolveVidarCwd(c) { return c; }",
    "config": "export async function resolveDefaultCwd() { return null; }",
    "drive/paste": "export async function drivePaste() {}",
  },
});
const { initDrive, hasRenderedAgent } = await import("../src/drive/drive.ts");
const { setRoster, rosterView } = await import("../src/launcher/roster.ts");

test("drive initialised before setRoster sees the roster that lands later", () => {
  initDrive({ spawnFrom: async () => "", roster: rosterView });
  assert.equal(hasRenderedAgent("claude"), false);
  setRoster([
    { key: "claude", id: "claude", label: "Claude" },
    { key: "claude-rendered", id: "claude", under: "claude", body: "rendered" },
  ]);
  assert.equal(hasRenderedAgent("claude"), true);
});
