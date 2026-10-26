// Vault warnings retain the per-tab Dismiss action.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({ stubs: { "panels/sessions/lookup": `
  export const getFocusedSession = () => null;
  export const renderedSessionId = () => null;
  export const renderedBody = () => null;` } });
const { vaultWarningLine } = await import("../src/panels/runes.ts");

test("Dismissing a vault warning hides it for that tab and text only", () => {
  const warning = "A library rune changed after this vault locked";
  const root = document.createElement("div");
  const line = vaultWarningLine(warning, "tabA");
  root.appendChild(line);
  assert.equal(line.querySelector(".runes-warn-text").textContent, warning);
  const dismiss = line.querySelector("button");
  assert.equal(dismiss.title, "Dismiss");
  dismiss.click();
  assert.equal(root.childElementCount, 0);
  assert.equal(vaultWarningLine(warning, "tabA"), null);
  assert.ok(vaultWarningLine(warning, "tabB"));
  assert.ok(vaultWarningLine("Another Warning", "tabA"));
});
