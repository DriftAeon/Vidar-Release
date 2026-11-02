// `window.__vidarDrive.shown()`: read-only report of the shown launcher rows, Rendered variants,
// onboarding and whether the dependency report landed (the zip boot check reads it).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "panels/sessions": `export function createSession() {} export function hasArmedAstra() { return false; }
      export function driveSnapshot() { return { tabs: [] }; } export const renderedDrive = {};
      export function sessionContainer() { return null; } export function writeToSession() {}`,
    "settings/registry": "export function getRegistry() { return {}; }",
    "config": "export async function resolveDefaultCwd() { return null; }",
    "drive/paste": "export async function drivePaste() {}",
  },
});
const { initDrive, driveShown } = await import("../src/drive/drive.ts");

const claude = { key: "claude", id: "claude" };
const claudeR = { key: "claude-rendered", id: "claude", under: "claude", body: "rendered", label: "Rendered" };
const keyless = { id: "local", under: "claude", body: "rendered", label: "Local R" };
const hidden = { key: "gone", id: "gone" };

test("shown() is empty and not landed when the host injects no source", () => {
  initDrive({ spawnFrom: async () => "", roster: () => ({ variantsOf: new Map(), launcherTypes: [] }) });
  assert.deepEqual(driveShown(), { roots: [], rendered: [], onboarding: false, depsLanded: false });
});

test("shown() lists shown root ids and Rendered variants, with the flags", () => {
  let landed = false;
  let open = true;
  initDrive({
    spawnFrom: async () => "",
    roster: () => ({ variantsOf: new Map(), launcherTypes: [] }),
    shown: {
      roots: () => [claude],
      variants: (r) => (r === claude ? [claudeR, keyless, { key: "raw", id: "claude" }] : []),
      depsLanded: () => landed,
      onboardingOpen: () => open,
    },
  });
  assert.deepEqual(window.__vidarDrive.shown(), {
    roots: ["claude"], rendered: ["claude-rendered", "claude/Local R"], onboarding: true, depsLanded: false,
  });
  landed = true;
  open = false;
  const s = window.__vidarDrive.shown();
  assert.equal(s.depsLanded, true);
  assert.equal(s.onboarding, false);
  void hidden;
});
