// `ctl.spawn`'s hosted check (drive.ts `hostedRenderedAgent`) agrees with the split
// `attachRenderedBody` makes: Claude always hosted; Codex only with vidar.json
// `falcon.hostedCodex` on and a row with no rules file and no profile (`codexHostShape`).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "panels/sessions": `export function createSession() {} export function hasArmedAstra() { return false; }
      export function driveSnapshot() { return { tabs: [] }; } export const renderedDrive = {};
      export function sessionContainer() { return null; } export function writeToSession() {}`,
    "panels/askgate": "export const pendingAsks = new Map();",
    "settings/registry": "export function getRegistry() { return {}; }",
    "config": "export async function resolveDefaultCwd() { return null; }",
    "drive/paste": "export async function drivePaste() {}",
  },
});
const { initDrive, hostedRenderedAgent, driveOpenTab } = await import("../src/drive/drive.ts");
const { setHostedCodexGate } = await import("../src/launcher/readopt.ts");

let launcherTypes = [];
let spawned = null;
initDrive({ spawnFrom: async (row) => { spawned = row; return "tab"; }, roster: () => ({ variantsOf: new Map(), launcherTypes }) });

const claude = { id: "claude", body: "rendered" };
const codex = { id: "codex", body: "rendered" };

test("Claude passes the spawn check whatever the hosted-Codex gate", () => {
  launcherTypes = [claude];
  setHostedCodexGate(false);
  assert.equal(hostedRenderedAgent("claude"), true);
  setHostedCodexGate(true);
  assert.equal(hostedRenderedAgent("claude"), true);
});

test("hosted Codex (gate on, plain row) passes the spawn check", () => {
  launcherTypes = [codex];
  setHostedCodexGate(true);
  assert.equal(hostedRenderedAgent("codex"), true);
});

test("unhosted Codex refuses: gate off", () => {
  launcherTypes = [codex];
  setHostedCodexGate(false);
  assert.equal(hostedRenderedAgent("codex"), false);
});

test("a bare Codex row hosts; another profile or one with rules stays in-process", () => {
  setHostedCodexGate(true);
  launcherTypes = [{ ...codex, profile: "bare" }];
  assert.equal(hostedRenderedAgent("codex"), true);
  launcherTypes = [{ ...codex, profile: "other" }];
  assert.equal(hostedRenderedAgent("codex"), false);
  launcherTypes = [{ ...codex, key: "codex-rules", rules: ["terse"] }];
  assert.equal(hostedRenderedAgent("codex"), false);
});

test("Codex rules that cannot apply (no key) leave the row hostable, as at launch", () => {
  setHostedCodexGate(true);
  launcherTypes = [{ ...codex, rules: ["terse"] }];
  assert.equal(hostedRenderedAgent("codex"), true);
});

test("ctl.spawn effort: Codex max becomes xhigh, Claude max stays max", async () => {
  launcherTypes = [claude, codex];
  await driveOpenTab({ agent: "codex", effort: "max", cwd: "C:/x" });
  assert.equal(spawned.effort, "xhigh");
  await driveOpenTab({ agent: "codex", effort: "high", cwd: "C:/x" });
  assert.equal(spawned.effort, "high");
  await driveOpenTab({ agent: "claude", effort: "max", cwd: "C:/x" });
  assert.equal(spawned.effort, "max");
});

test("an agent with no rendered row refuses", () => {
  launcherTypes = [];
  setHostedCodexGate(true);
  assert.equal(hostedRenderedAgent("codex"), false);
  assert.equal(hostedRenderedAgent("claude"), false);
});
