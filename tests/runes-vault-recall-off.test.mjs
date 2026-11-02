// view-vault.ts: a recall member the vault's copy holds off (`rune_vault_read`'s
// `off` list) draws off inside its runeset, and its switch sends the `member` op like a slotted rune's.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { runeGroups } = await import("../src/runes/bare/rune-groups.ts");
// the vault pane's input to the one grouping function (view-vault.ts vaultModify)
const paneGroups = (view, removed) => runeGroups({ sets: view.vault.runesets.map((r) => ({ source: r.source, members: [], on: true })),
  runes: view.runes, off: view.off, removed, held: view.vault.runes });
const { libraryTargets, rowState, setWanted, pendingOps, memberOp } = await import("../src/runes/bare/vault-pending.ts");

const inst ={ library: "installed", set: "installed" };
const rune = (id, recall = false) => ({ id, library: "installed", set: inst, kind: "rule", activate: recall ? "recall" : "always",
  description: "", section: [], recall, body: "", drift: false });
const vault = { id: "v1", runesets: [{ source: inst }], runes: [] };

test("a recall member in the reply's off list is drawn off inside its runeset", () => {
  const g = paneGroups({ vault, runes: [rune("a")], off: [rune("tip", true)] }, []);
  assert.deepEqual(g.sets.map((s) => [s.on, s.runes.map((r) => r.id), s.off]), [[true, ["a", "tip"], ["installed/tip"]]]);
});

test("the same member taken out this view and listed off is drawn once", () => {
  const g = paneGroups({ vault, runes: [rune("a")], off: [rune("tip", true)] }, [rune("tip", true)]);
  assert.deepEqual(g.sets[0].runes.map((r) => r.id), ["a", "tip"]);
  assert.deepEqual(g.sets[0].off, ["installed/tip"]);
});

test("a reply with no off list draws every member on", () => {
  const g = paneGroups({ vault, runes: [rune("a"), rune("tip", true)] }, []);
  assert.deepEqual(g.sets[0].off, []);
});

// off-rune: the store now keeps a switched-off slot member (`slot-off`) and a
// switched-off one-off (`Vault::off`) in the reply's off list, so after Done (removed is empty) both still draw off.
const baseRune = (id) => ({ ...rune(id), library: "base", set: null });

test("after Done a switched-off slot member from the reply's off list is drawn off and counted", () => {
  const g = paneGroups({ vault, runes: [rune("a")], off: [rune("plain")] }, []);
  assert.deepEqual(g.sets.map((s) => [s.runes.map((r) => r.id), s.off]), [[["a", "plain"], ["installed/plain"]]]);
});

test("after Done a switched-off one-off from the reply's off list is drawn off beside the on ones", () => {
  const v = { ...vault, runesets: [], runes: [{ library: "base", id: "gate" }] };
  const g = paneGroups({ vault: v, runes: [baseRune("gate")], off: [baseRune("mcp-gate")] }, []);
  assert.deepEqual(g.satchel.map((o) => [o.rune.id, o.on]), [["gate", true], ["mcp-gate", false]]);
});

test("the Rune Library reads a one-off the vault holds off as off, and ticking it stages addRune", () => {
  const v = { ...vault, runesets: [], runes: [] };
  const view = { vault: v, runes: [], off: [baseRune("mcp-gate")] };
  const changes = new Map();
  const ts = libraryTargets(view, changes, baseRune("mcp-gate"));
  assert.equal(rowState(changes, ts).on, false);
  for (const x of ts) setWanted(changes, x.target, x.base, true);
  assert.deepEqual(pendingOps(changes), [{ op: "addRune", ref: { library: "base", id: "mcp-gate" } }]);
});

test("a recall member's switch sends the member op", () => {
  assert.deepEqual(memberOp(inst, rune("tip", true), true),
    { op: "member", ref: { library: "installed", runeset: "installed", rune: { library: "installed", id: "tip" }, on: true } });
});
