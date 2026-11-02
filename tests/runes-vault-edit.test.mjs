// vault-edit.ts: the one Modify write path into a Rune Vault never edits a locked
// vault without the user's pick, turns the first-message lock race into the choice, and settles each mode.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { editVault, settleEdit, choiceCard } = await import("../src/runes/bare/vault-edit.ts");
const { runeGroups } = await import("../src/runes/bare/rune-groups.ts");
// the vault pane's input to the one grouping function (view-vault.ts vaultModify)
const paneGroups = (view, removed) => runeGroups({ sets: view.vault.runesets.map((r) => ({ source: r.source, members: [], on: true })),
  runes: view.runes, off: view.off, removed, held: view.vault.runes });
const { libraryPane } = await import("../src/runes/bare/view-library.ts");
const P = await import("../src/runes/bare/vault-pending.ts");
const { memberOp } = P;
const { vaultModifyState } = await import("../src/runes/bare/vault-modify-state.ts");

const OPS = [{ op: "removeRune", ref: { library: "installed", id: "tidy" } }];
function fakeIo({ locked = false, lockOnEdit = false } = {}) {
  const calls = [];
  const vault = { id: "v1", lockedUtc: locked ? "t" : null, runes: [] };
  return {
    calls,
    read: async () => { calls.push(["current"]); return { vault: { ...vault }, drift: [], runes: [], warnings: [] }; },
    edit: async (a) => {
      calls.push(["edit", a.mode]);
      if (lockOnEdit) vault.lockedUtc = "t"; // the first message locked it between the read and the edit
      if (vault.lockedUtc && a.mode === "unlocked") throw new Error("vault \"v1\" is locked");
      return { ...vault, id: a.mode === "variant" ? "v2" : "v1", name: a.mode === "variant" ? "Plain Variant" : "Plain" };
    },
    respawn: async () => { calls.push(["respawn"]); },
  };
}
/** Edit, then settle, as vault-modify-state.ts does: the outcome kind, or the variant's name. */
async function editAndSettle(io, id, ops, pick) {
  const r = await editVault(io, id, ops, pick);
  if (r.kind !== "edited") return r.kind;
  await settleEdit(io, r);
  return r.mode === "variant" ? { saved: r.vault.name } : "done";
}
const edits = (io) => io.calls.filter(([n]) => n === "edit").map(([, m]) => m);

test("an open vault takes one unlocked edit, then the tab respawns fresh", async () => {
  const io = fakeIo();
  assert.equal(await editAndSettle(io, "v1", OPS), "done");
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
  assert.equal(await editAndSettle(io, "v1", OPS), "ask");
  assert.deepEqual(edits(io), ["unlocked"], "only the unlocked edit the store refused went out");
  assert.ok(!io.calls.some(([n]) => n === "respawn"));
});

test("Make Variant edits with mode variant and stops: no move, no respawn, the variant's name comes back", async () => {
  const io = fakeIo({ locked: true });
  assert.deepEqual(await editAndSettle(io, "v1", OPS, "variant"), { saved: "Plain Variant" });
  assert.deepEqual(io.calls, [["edit", "variant"]]);
});

test("Make Variant's pick leaves the notice on the Modify state, and opening Modify again is the view's to clear", async () => {
  const io = fakeIo({ locked: true });
  const vm = vaultModifyState(io);
  await vm.read("v1");
  assert.deepEqual(await vm.commit(OPS), { kind: "ask" });
  assert.ok(vm.pending, "a locked vault parks the edit");
  await vm.pick("variant");
  assert.equal(vm.notice, "Saved as Plain Variant. New sessions can pick it.");
  assert.equal(vm.pending, null);
});

test("Edit Original edits with mode invalidate, then respawns this tab fresh on the new revision", async () => {
  const io = fakeIo({ locked: true });
  assert.equal(await editAndSettle(io, "v1", OPS, "invalidate"), "done");
  assert.deepEqual(io.calls, [["edit", "invalidate"], ["respawn"]]);
});

const MEMBER = [{ op: "member", ref: { library: "installed", runeset: "workflow", rune: { library: "installed", id: "a" }, on: false } }];

test("a member toggle on a locked vault parks as the pending choice and sends nothing", async () => {
  const io = fakeIo({ locked: true });
  const vm = vaultModifyState(io);
  await vm.read("v1");
  assert.deepEqual(await vm.commit(MEMBER), { kind: "ask" });
  assert.deepEqual(vm.pending?.ops, MEMBER);
  assert.deepEqual(edits(io), []);
  await vm.pick("invalidate");
  assert.deepEqual(io.calls.filter(([n]) => n !== "current"), [["edit", "invalidate"], ["respawn"]]);
});

test("memberOp builds the store's member op, and takenOut keeps a switched-off member", () => {
  const workflow = { library: "installed", set: "workflow" };
  assert.deepEqual([memberOp(workflow, { library: "installed", id: "a" }, false)], MEMBER);
  const vm = vaultModifyState(fakeIo());
  const a = { id: "a", library: "installed", set: workflow, recall: false };
  vm.now = { vault: { id: "v1", runesets: [{ source: workflow }], runes: [] }, drift: [], warnings: [], runes: [a, { ...a, id: "b" }] };
  assert.deepEqual(vm.takenOut(MEMBER).map((r) => r.id), ["a"]);
  assert.deepEqual(vm.takenOut([{ ...MEMBER[0], ref: { ...MEMBER[0].ref, on: true } }]), []);
});

test("runeGroups lists a member switched out of a placed runeset as off inside that runeset", () => {
  const rune = (id, set) => ({ id, library: "installed", set, kind: "rule", activate: "", description: "", section: [], recall: false, body: "", drift: false });
  const workflow = { library: "installed", set: "workflow" };
  const view = { vault: { id: "v1", runesets: [{ source: workflow }], runes: [] }, drift: [], warnings: [], runes: [rune("a", workflow)] };
  const g = paneGroups(view, [rune("b", workflow), rune("a", workflow)]);
  assert.deepEqual(g.sets.map((s) => [s.source.set, s.on, s.runes.map((r) => r.id), s.off]), [["workflow", true, ["a", "b"], ["installed/b"]]]);
});

test("the Rune Library ticks every rune the vault holds, and a tick on one it lacks stages addRune for Done", async () => {
  const rune = (id, set, library = "installed") => ({ id, library, set, kind: "rule", activate: "", description: "", section: [], recall: false, body: "", drift: false, path: `${id}.md` });
  const workflow = { library: "installed", set: "workflow" };
  const view = { vault: { id: "v1", lockedUtc: null, runesets: [{ source: workflow }], runes: [{ library: "base", id: "one" }] }, drift: [], warnings: [],
    runes: [rune("a", workflow), rune("one", null, "base")] };
  const library = [rune("a", null), rune("b", null), rune("one", null, "base"), rune("a", null, "base")];

  const s = vaultModifyState(undefined);
  await s.loadLibrary(async () => library);
  assert.equal(s.library, library);
  s.reset();
  assert.equal(s.library, null, "leaving Modify drops the library");

  const changes = new Map();
  const pend = { on: (t, b) => P.effectiveOn(changes, t, b), pending: (t) => P.isPending(changes, t), flip: (t, b) => P.flip(changes, t, b),
    set: (ts, on) => { for (const x of ts) P.setWanted(changes, x.target, x.base, on); }, get count() { return changes.size; }, staged: () => [...changes.values()] };
  const draw = () => {
    const root = document.createElement("div");
    root.append(...libraryPane({ runes: library, view, changes, pend, still: false, busy: false, card: { openInDocument() {}, note() {} },
      trackOpen() {}, deleting: null, askDelete() {}, confirmDelete() {}, cancelDelete() {} }));
    return root;
  };
  const box = (root, lib, id) => root.querySelector(`.runes-check[data-keep="lib:${lib}/${id}"]`);
  const root = draw();
  // in a runeset or a one-off: held; the same id from another library is not
  assert.deepEqual(["installed/a", "installed/b", "base/one", "base/a"].map((k) => box(root, ...k.split("/")).getAttribute("aria-checked")),
    ["true", "false", "true", "false"]);
  box(root, "installed", "b").click();
  assert.deepEqual(P.pendingOps(changes), [{ op: "addRune", ref: { library: "installed", id: "b" } }]);
  assert.ok(box(draw(), "installed", "b").classList.contains("is-pending"));
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

test("runeGroups groups runeset runes under their runeset, keeps one-offs apart, and lists taken-out runes off", () => {
  const rune = (id, set, library = "installed") => ({ id, library, set, kind: "rule", activate: "", description: "", section: [], recall: false, body: "", drift: false });
  const workflow = { library: "installed", set: "workflow" };
  const view = { vault: { id: "v1", runesets: [{ source: workflow }], runes: [{ library: "installed", id: "b" }] }, drift: [], warnings: [],
    runes: [rune("a", workflow), rune("b", null)] };
  const g = paneGroups(view, [rune("c", null), rune("d", { library: "installed", set: "old" })]);
  assert.deepEqual(g.sets.map((s) => [s.source.set, s.on, s.runes.map((r) => r.id)]), [["workflow", true, ["a"]], ["old", false, ["d"]]]);
  assert.deepEqual(g.satchel.map((o) => [o.rune.id, o.on]), [["b", true], ["c", false]]);
});
