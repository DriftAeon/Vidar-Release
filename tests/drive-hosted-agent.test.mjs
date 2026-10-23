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
    "settings/registry": "export function getRegistry() { return {}; }",
    "config": "export async function resolveDefaultCwd() { return null; }",
    "drive/paste": "export async function drivePaste() {}",
  },
});
const { initDrive, hostedRenderedAgent, driveOpenTab, driveSnapshot } = await import("../src/drive/drive.ts");
const { openApproval, cancelApproval } = await import("../src/asks/approvals.ts");
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

test("state.cards lists the imperative approvals and card answers through the registry", async () => {
  const outcomes = [];
  const rec = (id, origin, rows) => ({ id, origin, title: "T", asker: { tab: "req", label: "Req", verified: true }, rows,
    askedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, comment: true, drawInAskerTab: true });
  openApproval(rec("c1", "ctl-prompt", [["Asked By", "Req"], ["Tab", "Title · t7"], ["Text", "hi"]]), (o) => outcomes.push(o));
  openApproval(rec("c2", "flow", [["Tool", "Bash"]]), () => {});
  const cards = driveSnapshot().cards;
  assert.deepEqual(cards.map((c) => c.id), ["c1"], "snapshot-derived origins are not drive cards");
  assert.deepEqual(cards[0], { id: "c1", kind: "ctl-prompt", title: "T", tab: "t7", details: { "Asked By": "Req", Tab: "Title · t7", Text: "hi" }, onScreen: true });
  const done = await window.__vidarDrive.card("c1", "deny", { comment: "nope" });
  assert.equal(done.decision, "deny");
  assert.deepEqual(outcomes, [{ verdict: "deny", comment: "nope", where: "Drive" }]);
  assert.deepEqual(driveSnapshot().cards, []);
  cancelApproval("c2", "done");
});
