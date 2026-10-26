import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");
test("A recall member is visible in its vault set and cannot be switched as a slot", () => {
  const set = { library: "kit", set: "kit" };
  const view = { vault: { id: "daily", runesets: [{ source: set }], runes: [], lockedUtc: null },
    runes: [{ set, library: "kit", id: "tip", kind: "fact", activate: "recall",
      description: "Tip", section: ["Recall"], recall: true, body: "Read this.", drift: false }],
    drift: [], warnings: [] };
  const root = document.createElement("div");
  root.append(...vaultModify({ view, removed: [], pending: null, busy: false,
    card: { openInDocument: () => {}, note: () => {} },
    trackOpen: () => {}, edit: () => assert.fail("recall member switched"),
    pick: async () => {} }));
  assert.ok(root.querySelector('[data-id="tip"]'));
  assert.equal(root.querySelector('[data-id="tip"] .runes-bare-switch').disabled, true);
});
