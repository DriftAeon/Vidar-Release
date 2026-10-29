import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");
// Its switch now sends the member op: tests/runes-vault-recall-off.test.mjs.
test("A recall member is visible in its vault set with its switch enabled", () => {
  const set = { library: "kit", set: "kit" };
  const view = { vault: { id: "daily", runesets: [{ source: set }], runes: [], lockedUtc: null },
    runes: [{ set, library: "kit", id: "tip", kind: "fact", activate: "recall",
      description: "Tip", section: ["Recall"], recall: true, body: "Read this.", drift: false }],
    drift: [], warnings: [] };
  const root = document.createElement("div");
  root.append(...vaultModify({ view, removed: [], pending: null, busy: false,
    card: { openInDocument: () => {}, note: () => {} },
    trackOpen: () => {}, edit: () => {},
    pick: async () => {} }));
  assert.ok(root.querySelector('[data-id="tip"]'));
  const check = root.querySelector('[data-id="tip"]').previousElementSibling;
  assert.equal(check.className, "runes-check");
  assert.equal(check.disabled, false);
});
