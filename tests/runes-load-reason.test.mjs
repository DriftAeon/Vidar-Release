import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { loadReason, notCarriedIds } = await import("../src/runes/bare/load-reason.ts");
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");

const loads = (extra = {}) => ({ source: "transcript", files: [], truncated: false, ...extra });
const rune = (o) => ({ id: "r", activate: "recall", ...o });

test("load reason precedence over rows 1-6", () => {
  const warn = ["skill r Not Carried by Codex: no skills"];
  assert.equal(loadReason(rune({}), { state: "off", notCarried: notCarriedIds(warn), loads: loads() }), "Not Loaded: Not Carried by This Agent");
  assert.equal(loadReason(rune({}), { state: "off", loads: loads() }), "Not Loaded: Off in This Vault");
  assert.equal(loadReason(rune({ activate: "always" }), { state: "on", loads: loads() }), "Loaded: At Start");
  assert.equal(loadReason(rune({ activate: "always" }), { state: "on", loads: null }), null);
  assert.equal(loadReason(rune({}), { state: "off", loads: null }), "Not Loaded: Off in This Vault");
  assert.equal(loadReason(rune({ recall: true }), { state: "on", loads: loads({ runeReads: ["r"] }) }), "Loaded: On Recall");
  assert.equal(loadReason(rune({ recall: true }), { state: "on", loads: loads() }), "Not Loaded: Pointer Line Only");
  assert.equal(loadReason(rune({ kind: "procedure" }), { state: "on", loads: loads({ runeReads: ["r"] }) }), "Loaded: On Invoke");
  assert.equal(loadReason(rune({ kind: "procedure" }), { state: "on", loads: loads() }), "Not Loaded: Pointer Line Only");
  assert.equal(loadReason(rune({ recall: true }), { state: "on", loads: null }), null);
});

test("a paths rune names its trigger's basename, or none", () => {
  const p = rune({ activate: "paths", paths: ["*.ts"] });
  assert.equal(loadReason(p, { state: "on", loads: loads({ runeReads: ["r"], runeTriggers: { r: "C:\\a\\b\\x.ts" } }) }), "Loaded: On Path (x.ts)");
  assert.equal(loadReason(p, { state: "on", loads: loads({ runeReads: ["r"] }) }), "Loaded: On Path");
  assert.equal(loadReason(p, { state: "on", loads: loads() }), "Not Loaded: Pointer Line Only");
});

test("a vault card marks a read rune is-read and carries the reason in its tooltip", () => {
  const set = { library: "kit", set: "kit" };
  const mk = (id) => ({ set, library: "kit", id, kind: "fact", activate: "recall", description: "D", section: [], recall: true, body: "b", drift: false });
  const view = { vault: { id: "v", runesets: [{ source: set }], runes: [], lockedUtc: null }, runes: [mk("seen"), mk("unseen")], drift: [], warnings: [] };
  const root = document.createElement("div");
  root.append(...vaultModify({ view, removed: [], pending: null, busy: false, loads: loads({ runeReads: ["seen"] }),
    card: { openInDocument: () => {}, note: () => {} }, trackOpen: () => {}, edit: () => {}, pick: async () => {} }));
  const seen = root.querySelector('[data-id="seen"]'), unseen = root.querySelector('[data-id="unseen"]');
  assert.ok(seen.classList.contains("is-read"));
  assert.ok(!unseen.classList.contains("is-read"));
  assert.match(seen.querySelector("summary").title, /Loaded: On Recall/);
  assert.match(unseen.querySelector("summary").title, /Not Loaded: Pointer Line Only/);
});
