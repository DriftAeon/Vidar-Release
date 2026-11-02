// Recurrence control for "proxy" shown instead of "Proxy": lint-copy sees only static strings, so runtime ids
// (module names, loaded file names) are drawn from lowercase fixtures and every visible label must start uppercase.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({ stubs: { "panels/sessions/lookup": `
  export const getFocusedSession = () => null;
  export const renderedSessionId = () => null;
  export const renderedBody = () => null;
  export const sessionLaunchInfo = () => null;
  export const pendingVaultTab = () => null;` } });
const { vaultWarningLine } = await import("../src/panels/runes.ts");

test("A Not Carried warning renders the kind icon and mono id", () => {
  const line = vaultWarningLine("skill drive-allow Not Carried by Codex: no per-tool list", "tabNC");
  assert.equal(line.querySelector(".nm-mono").textContent, "drive-allow");
  assert.ok(line.querySelector(".runes-warn-text img, .runes-warn-text svg"));
});
