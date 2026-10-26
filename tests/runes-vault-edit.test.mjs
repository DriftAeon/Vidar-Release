// vault-edit.ts (run 2026-10-25-rune-vault L3b2): the one Modify write path into a Rune Vault never edits a locked
// vault without the user's pick, turns the first-message lock race into the choice, and settles each mode.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { editVault, applyVaultEdit, addGeneratedToVault, choiceCard } = await import("../src/runes/bare/vault-edit.ts");
const { vaultGroups, memberOp, addable, vaultModify } = await import("../src/runes/bare/view-vault.ts");
const { vaultModifyState } = await import("../src/runes/bare/vault-modify-state.ts");

const OPS = [{ op: "removeRune", ref: { library: "kit", id: "tidy" } }];
function fakeIo({ locked = false, lockOnEdit = false, moved = true } = {}) {
  const calls = [];
  const vault = { id: "v1", lockedUtc: locked ? "t" : null, runes: [] };
  return {
    calls,
    current: async () => { calls.push(["current"]); return { ...vault }; },
    currentView: async () => ({ vault: { ...vault }, drift: [], runes: [], warnings: [] }),
    edit: async (a) => {
      calls.push(["edit", a.mode]);
      if (lockOnEdit) vault.lockedUtc = "t"; // the first message locked it between the read and the edit
      if (vault.lockedUtc && a.mode === "unlocked") throw new Error("vault \"v1\" is locked");
      return { ...vault, id: a.mode === "variant" ? "v2" : "v1" };
    },
    moveTab: async (id) => { calls.push(["moveTab", id]); return moved; },
    respawn: async () => { calls.push(["respawn"]); },
  };
}
const edits = (io) => io.calls.filter(([n]) => n === "edit").map(([, m]) => m);

test("an open vault takes one unlocked edit, then the tab respawns fresh", async () => {
  const io = fakeIo();
  assert.equal(await applyVaultEdit(io, "v1", OPS), "done");
  assert.deepEqual(edits(io), ["unlocked"]);
  assert.deepEqual(io.calls.at(-1), ["respawn"]);
});

test("a locked vault asks and sends no edit at all", async () => {
  const io = fakeIo({ locked: true });
  assert.deepEqual(await editVault(io, "v1", OPS), { kind: "ask" });
  assert.deepEqual(edits(io), []);
});

test("the lock race: a vault locked between the read and the edit asks instead of failing", async () => {
  const io = fakeIo({ lockOnEdit: true });
  assert.equal(await applyVaultEdit(io, "v1", OPS), "ask");
  assert.deepEqual(edits(io), ["unlocked"], "only the unlocked edit the store refused went out");
  assert.ok(!io.calls.some(([n]) => n === "respawn"));
});

test("Make Variant edits with mode variant, moves the tab to the new id, then respawns", async () => {
  const io = fakeIo({ locked: true });
  assert.equal(await applyVaultEdit(io, "v1", OPS, "variant"), "done");
  assert.deepEqual(io.calls, [["edit", "variant"], ["moveTab", "v2"], ["respawn"]]);
});

test("Make Variant with no session record throws and does not respawn", async () => {
  const io = fakeIo({ locked: true, moved: false });
  await assert.rejects(applyVaultEdit(io, "v1", OPS, "variant"), /This tab has no vault session to move\./);
  assert.ok(!io.calls.some(([n]) => n === "respawn"));
});

test("Edit Original edits with mode invalidate, then respawns this tab fresh on the new revision", async () => {
  const io = fakeIo({ locked: true });
  assert.equal(await applyVaultEdit(io, "v1", OPS, "invalidate"), "done");
  assert.deepEqual(io.calls, [["edit", "invalidate"], ["respawn"]]);
});

const MEMBER = [{ op: "member", ref: { library: "kit", runeset: "workflow", rune: { library: "kit", id: "a" }, on: false } }];

test("a member toggle on a locked vault parks as the pending choice and sends nothing", async () => {
  const io = fakeIo({ locked: true });
  const vm = vaultModifyState(io);
  await vm.read("v1");
  await vm.edit(MEMBER, []);
  assert.deepEqual(vm.pending?.ops, MEMBER);
  assert.deepEqual(edits(io), []);
  await vm.pick("invalidate");
  assert.deepEqual(io.calls.filter(([n]) => n !== "current"), [["edit", "invalidate"], ["respawn"]]);
});

test("memberOp builds the store's member op, and takenOut keeps a switched-off member", () => {
  const workflow = { library: "kit", set: "workflow" };
  assert.deepEqual([memberOp(workflow, { library: "kit", id: "a" }, false)], MEMBER);
  const vm = vaultModifyState(fakeIo());
  const a = { id: "a", library: "kit", set: workflow, recall: false };
  vm.now = { vault: { id: "v1", runesets: [{ source: workflow }], runes: [] }, drift: [], warnings: [], runes: [a, { ...a, id: "b" }] };
  assert.deepEqual(vm.takenOut(MEMBER).map((r) => r.id), ["a"]);
  assert.deepEqual(vm.takenOut([{ ...MEMBER[0], ref: { ...MEMBER[0].ref, on: true } }]), []);
});

test("vaultGroups lists a member switched out of a placed runeset as off inside that runeset", () => {
  const rune = (id, set) => ({ id, library: "kit", set, kind: "rule", activate: "", description: "", section: [], recall: false, body: "", drift: false });
  const workflow = { library: "kit", set: "workflow" };
  const view = { vault: { id: "v1", runesets: [{ source: workflow }], runes: [] }, drift: [], warnings: [], runes: [rune("a", workflow)] };
  const g = vaultGroups(view, [rune("b", workflow), rune("a", workflow)]);
  assert.deepEqual(g.sets.map((s) => [s.source.set, s.on, s.runes.map((r) => r.id), s.off]), [["workflow", true, ["a", "b"], ["kit/b"]]]);
});

test("Add Rune lists only library runes the vault does not hold, and its switch sends addRune", async () => {
  const rune = (id, set, library = "kit") => ({ id, library, set, kind: "rule", activate: "", description: "", section: [], recall: false, body: "", drift: false });
  const workflow = { library: "kit", set: "workflow" };
  const view = { vault: { id: "v1", lockedUtc: null, runesets: [{ source: workflow }], runes: [{ library: "stock", id: "one" }] }, drift: [], warnings: [],
    runes: [rune("a", workflow), rune("one", null, "stock")] };
  const library = [rune("a", null), rune("b", null), rune("one", null, "stock"), rune("gone", null), rune("a", null, "stock"), rune("c", null)];
  // in a runeset, a one-off, or switched off by this Modify: all held; the same id from another library is not
  assert.deepEqual(addable(library, view, [rune("gone", null)]).map((r) => `${r.library}/${r.id}`), ["kit/b", "stock/a", "kit/c"]);

  const s = vaultModifyState(undefined);
  await s.toggleLibrary(async () => library);
  assert.equal(s.library, library);
  await s.toggleLibrary(async () => { throw new Error("an open list closes without a read"); });
  assert.equal(s.library, null);
  await s.toggleLibrary(async () => library);
  s.reset();
  assert.equal(s.library, null, "leaving Modify closes the list");

  const sent = [];
  const base = { view, removed: [], pending: null, busy: false, card: { openInDocument() {}, note() {} }, trackOpen() {}, edit: (ops) => sent.push(...ops), pick: async () => {} };
  const closed = vaultModify({ ...base, library: null, addRune() {} });
  const button = closed.flatMap((n) => [...n.querySelectorAll("button")]).find((b) => b.textContent === "Add Rune");
  assert.ok(button, "the Add Rune button shows when the view can add");
  assert.equal(closed.at(-1).className, "rp-actions", "a closed list draws nothing after the actions");
  const open = vaultModify({ ...base, library: [rune("a", null), rune("b", null)], addRune() {} });
  const switches = [...open.at(-1).querySelectorAll(".runes-bare-switch")];
  assert.equal(switches.length, 1, "kit/a is already in the vault's runeset");
  switches[0].click();
  assert.deepEqual(sent, [{ op: "addRune", ref: { library: "kit", id: "b" } }]);
  const empty = vaultModify({ ...base, library: [rune("a", null)], addRune() {} });
  assert.equal(empty.at(-1).className, "rp-actions", "nothing left to add draws no list");
  assert.equal(empty.at(-1).querySelector("button").title, "Every rune your libraries offer this agent is already in this vault.");
});

test("Add to Vault on a locked vault asks; on an open one it edits and respawns", async () => {
  const ref = { library: "gen-claude-bare", set: "gen" };
  const shut = fakeIo({ locked: true });
  assert.equal(await addGeneratedToVault(shut, "v1", ref), "ask");
  assert.deepEqual(edits(shut), []);
  const open = fakeIo();
  assert.equal(await addGeneratedToVault(open, "v1", ref), "done");
  assert.deepEqual(edits(open), ["unlocked"]);
  assert.deepEqual(open.calls.at(-1), ["respawn"]);
});

test("the choice card carries the note and both picks, and a failed pick shows on its error line", async () => {
  const picks = [];
  const card = choiceCard(async (p) => { picks.push(p); if (p === "invalidate") throw new Error("Edit refused"); });
  assert.ok(card.classList.contains("blk-notice-card"));
  assert.equal(card.querySelector(".blk-notice").textContent, "Earlier sessions on this vault become invalid.");
  const [variant, original] = card.querySelectorAll("button");
  assert.equal(variant.textContent, "Make Variant");
  assert.ok(variant.classList.contains("wb-card-btn-primary"));
  assert.equal(original.textContent, "Edit Original");
  original.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(picks, ["invalidate"]);
  assert.equal(card.querySelector(".notice-err").hidden, false);
  assert.equal(card.querySelector(".notice-err").textContent, "Edit refused");
  assert.ok(original.classList.contains("is-error"));
});

test("vaultGroups groups runeset runes under their runeset, keeps one-offs apart, and lists taken-out runes off", () => {
  const rune = (id, set, library = "kit") => ({ id, library, set, kind: "rule", activate: "", description: "", section: [], recall: false, body: "", drift: false });
  const workflow = { library: "kit", set: "workflow" };
  const view = { vault: { id: "v1", runesets: [{ source: workflow }], runes: [{ library: "kit", id: "b" }] }, drift: [], warnings: [],
    runes: [rune("a", workflow), rune("b", null)] };
  const g = vaultGroups(view, [rune("c", null), rune("d", { library: "kit", set: "old" })]);
  assert.deepEqual(g.sets.map((s) => [s.source.set, s.on, s.runes.map((r) => r.id)]), [["workflow", true, ["a"]], ["old", false, ["d"]]]);
  assert.deepEqual(g.oneOffs.map((o) => [o.rune.id, o.on]), [["b", true], ["c", false]]);
});
