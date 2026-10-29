// view-vault.ts: a recall member the vault's copy holds off (`rune_vault_read`'s
// `off` list) draws off inside its runeset, and its switch sends the `member` op like a slotted rune's.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { vaultGroups, memberOp, addable } = await import("../src/runes/bare/view-vault.ts");

const kit = { library: "kit", set: "kit" };
const rune = (id, recall = false) => ({ id, library: "kit", set: kit, kind: "rule", activate: recall ? "recall" : "always",
  description: "", section: [], recall, body: "", drift: false });
const vault = { id: "v1", runesets: [{ source: kit }], runes: [] };

test("a recall member in the reply's off list is drawn off inside its runeset", () => {
  const g = vaultGroups({ vault, runes: [rune("a")], off: [rune("tip", true)] }, []);
  assert.deepEqual(g.sets.map((s) => [s.on, s.runes.map((r) => r.id), s.off]), [[true, ["a", "tip"], ["kit/tip"]]]);
});

test("the same member taken out this view and listed off is drawn once", () => {
  const g = vaultGroups({ vault, runes: [rune("a")], off: [rune("tip", true)] }, [rune("tip", true)]);
  assert.deepEqual(g.sets[0].runes.map((r) => r.id), ["a", "tip"]);
  assert.deepEqual(g.sets[0].off, ["kit/tip"]);
});

test("a reply with no off list draws every member on", () => {
  const g = vaultGroups({ vault, runes: [rune("a"), rune("tip", true)] }, []);
  assert.deepEqual(g.sets[0].off, []);
});

// off-rune: the store now keeps a switched-off slot member (`slot-off`) and a
// switched-off one-off (`Vault::off`) in the reply's off list, so after Done (removed is empty) both still draw off.
const stockRune = (id) => ({ ...rune(id), library: "stock", set: null });

test("after Done a switched-off slot member from the reply's off list is drawn off and counted", () => {
  const g = vaultGroups({ vault, runes: [rune("a")], off: [rune("plain")] }, []);
  assert.deepEqual(g.sets.map((s) => [s.runes.map((r) => r.id), s.off]), [[["a", "plain"], ["kit/plain"]]]);
});

test("after Done a switched-off one-off from the reply's off list is drawn off beside the on ones", () => {
  const v = { ...vault, runesets: [], runes: [{ library: "stock", id: "gate" }] };
  const g = vaultGroups({ vault: v, runes: [stockRune("gate")], off: [stockRune("mcp-gate")] }, []);
  assert.deepEqual(g.oneOffs.map((o) => [o.rune.id, o.on]), [["gate", true], ["mcp-gate", false]]);
});

test("Add Rune leaves out a one-off the vault holds off", () => {
  const v = { ...vault, runesets: [], runes: [] };
  const got = addable([stockRune("mcp-gate"), stockRune("other")], { vault: v, runes: [], off: [stockRune("mcp-gate")] });
  assert.deepEqual(got.map((r) => r.id), ["other"]);
});

test("a recall member's switch sends the member op", () => {
  assert.deepEqual(memberOp(kit, rune("tip", true), true),
    { op: "member", ref: { library: "kit", runeset: "kit", rune: { library: "kit", id: "tip" }, on: true } });
});
