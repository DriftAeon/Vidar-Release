// Both Runes panes group through one function (rune-groups.ts): the Rune Library (libraryPane) and the vault view
// (vaultModify) put each rune in the same group, whatever the vault holds. Group key = the card's library/runeset
// (`data-library`, `data-runeset`) or the Rune Satchel.
//
// The one divergence: a Kit member the vault holds loose sits in the right pane's Satchel (the vault's Kit copy, if
// any, does not list it) and under Kit on the left (the library runeset names it). Checked on its own below.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { libraryPane } = await import("../src/runes/bare/view-library.ts");
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");
const P = await import("../src/runes/bare/vault-pending.ts");

const BASE = { library: "base", set: "base-set" };
const KIT = { library: "mine", set: "kit" };
const rune = (library, id, set = null) => ({ id, library, set, kind: "rule", activate: "", description: "D", section: [], recall: false, body: "b", drift: false, path: `${id}.md` });
const FIRST = { library: "mine", set: "first" };
// two runesets that share a rune (the runes-e2e seed's First and Second)
const PAIR_A = { library: "pair", set: "pair-a" };
const PAIR_B = { library: "pair", set: "pair-b" };
const library = [rune("base", "a"), rune("base", "b"), rune("base", "c"), rune("runes", "unreal-bridge"), rune("mine", "kit-a"),
  rune("mine", "first-only"), rune("mine", "first-two"), rune("pair", "pa"), rune("pair", "pb"), rune("pair", "shared")];
const runesets = [
  { ...BASE, members: ["a", "b", "c"].map((id) => ({ library: "base", id })), fixed: true },
  { ...KIT, members: [{ library: "mine", id: "kit-a" }], fixed: false },
  { ...FIRST, members: ["first-only", "first-two"].map((id) => ({ library: "mine", id })), fixed: false },
  { ...PAIR_A, members: ["pa", "shared"].map((id) => ({ library: "pair", id })), fixed: false },
  { ...PAIR_B, members: ["pb", "shared"].map((id) => ({ library: "pair", id })), fixed: false },
];

// the staging view.ts wires: every flip and set carries the style targets
function staging(view, changes = new Map(), joins = []) {
  for (const s of joins) P.flip(changes, { t: "set", source: s }, false);
  const styles = () => P.styleTargets(view, changes, library);
  const pend = { on: (t, b) => P.effectiveOn(changes, t, b), pending: (t) => P.isPending(changes, t), flip: (t, b) => P.flip(changes, t, b, styles()),
    set: (ts, on) => { const s = styles(); for (const x of ts) P.setWanted(changes, x.target, x.base, on, s); },
    get count() { return changes.size; }, staged: () => [...changes.values()] };
  return { changes, pend };
}
const card = { openInDocument() {}, note() {} };

function panes(view, joins = [], staged = new Map()) {
  const { changes, pend } = staging(view, staged, joins);
  const left = document.createElement("div");
  left.append(...libraryPane({ runes: library, runesets, view, changes, pend, still: false, busy: false, card, trackOpen() {},
    deleting: null, askDelete() {}, confirmDelete() {}, cancelDelete() {} }));
  const right = document.createElement("div");
  right.append(...vaultModify({ view, removed: [], pending: null, busy: false, card, trackOpen() {}, pick: async () => {}, pend,
    libraryRunes: library, librarySets: runesets }));
  return { left, right, changes };
}

/** A runeset card's head count ("on/all") in `root`, or null when the pane draws no such card. */
const countOf = (root, s) => root.querySelector(`details.runes-set[data-library="${s.library}"][data-runeset="${s.set}"] > summary .runes-sc`)?.textContent ?? null;
/** rune id → its checkbox state ("true"/"false") in `root`; the row's box sits beside its card. */
function ticks(root) {
  const out = new Map();
  for (const d of root.querySelectorAll("details.runes-rn")) out.set(d.dataset.id, d.parentElement.querySelector(":scope > .runes-check")?.getAttribute("aria-checked") ?? null);
  return out;
}
const headBox = (root, s) => root.querySelector(`details.runes-set[data-runeset="${s.set}"] > summary > .runes-check`);
const runeBox = (root, id) => root.querySelector(`details.runes-rn[data-id="${id}"]`).parentElement.querySelector(":scope > .runes-check");

/** rune id (unique in these fixtures) → its group key ("library/runeset", or "satchel"), as drawn in `root`. */
function keys(root) {
  const out = new Map();
  for (const d of root.querySelectorAll("details.runes-rn")) {
    const set = d.closest("details[data-runeset]");
    out.set(d.dataset.id, d.closest(".runes-satchel") ? "satchel" : `${set.dataset.library}/${set.dataset.runeset}`);
  }
  return out;
}
const titles = (root) => [...root.querySelectorAll(":scope > .runes-group > details.runes-set > .runes-set-head .runes-sn")].map((e) => e.textContent);

const vault = (over) => ({ id: "v", name: "V", hash: "h", lockedUtc: null, runesets: [], runes: [], pins: {}, ...over });
const view = (v, runes, off = []) => ({ vault: v, runes, off, drift: [], warnings: [] });

function agree({ left, right }, except = []) {
  const l = keys(left);
  const r = keys(right);
  assert.ok(r.size, "the right pane draws runes");
  for (const [id, g] of r) if (!except.includes(id)) assert.equal(l.get(id), g, `${id} sits in the same group on both sides`);
  for (const t of [...titles(left), ...titles(right)]) assert.ok(t !== "Base" && t !== "Runes", `no card titled ${t}`);
  for (const root of [left, right])
    for (const d of root.querySelectorAll(".runes-satchel details.runes-rn")) assert.ok(d.dataset.library, "a Satchel row names its own library");
}

test("Base Set placed with b slot-off and a loose runes/unreal-bridge: the same groups on both sides", () => {
  const v = view(vault({ runesets: [{ source: BASE }], runes: [{ library: "runes", id: "unreal-bridge" }] }),
    [rune("base", "a", BASE), rune("base", "c", BASE), rune("runes", "unreal-bridge")], [rune("base", "b", BASE)]);
  const p = panes(v);
  agree(p);
  const r = keys(p.right);
  assert.equal(r.get("b"), "base/base-set", "the slot-off member stays under its runeset");
  assert.equal(r.get("unreal-bridge"), "satchel");
  assert.equal(keys(p.left).get("unreal-bridge"), "satchel");
});

test("Base Set in off_sets: its runes sit under Base Set on both sides", () => {
  const v = view(vault({}), [], ["a", "b", "c"].map((id) => rune("base", id, BASE)));
  const p = panes(v);
  agree(p);
  assert.deepEqual([...new Set(keys(p.right).values())], ["base/base-set"]);
  assert.deepEqual(titles(p.right), ["Base Set"]);
});

test("Kit staged to join lists its member on both sides, the loose kit-a included", () => {
  const v = view(vault({ runes: [{ library: "mine", id: "kit-a" }, { library: "runes", id: "unreal-bridge" }] }),
    [rune("mine", "kit-a"), rune("runes", "unreal-bridge")]);
  const p = panes(v, [KIT]);
  assert.ok(titles(p.right).includes("Kit"), "the joining runeset has its card");
  assert.equal(p.right.querySelector('details[data-runeset="kit"]').dataset.library, "mine");
  agree(p);
  assert.equal(keys(p.right).get("kit-a"), "mine/kit");
});

// New Rune Vault before Done: Base Set placed, every other library runeset unplaced
const fresh = () => view(vault({ runesets: [{ source: BASE }] }), ["a", "b", "c"].map((id) => rune("base", id, BASE)));
/** Both panes agree on groups, and on First's count and each First member's tick. */
function sameFirst(p, count, on) {
  agree(p);
  assert.equal(countOf(p.left, FIRST), count, "the library's First count");
  assert.equal(countOf(p.right, FIRST), count, "the vault view's First count");
  for (const root of [p.left, p.right]) {
    const t = ticks(root);
    for (const [id, want] of Object.entries(on)) assert.equal(t.get(id), want ? "true" : "false", `${id} reads ${want ? "on" : "off"}`);
    assert.equal(keys(root).get("first-only"), "mine/first");
    assert.equal(keys(root).get("first-two"), "mine/first");
  }
}

test("joining First from the library head: the vault view's First lists both members, on, 2/2", () => {
  const v = fresh();
  let p = panes(v);
  headBox(p.left, FIRST).click();
  p = panes(v, [], p.changes);
  sameFirst(p, "2/2", { "first-only": true, "first-two": true });
  assert.deepEqual(P.pendingOps(p.changes), [{ op: "addRuneset", ref: FIRST }]);
});

test("joining First, then unticking First Only in the library: both panes read 1/2 under First", () => {
  const v = fresh();
  let p = panes(v);
  headBox(p.left, FIRST).click();
  p = panes(v, [], p.changes);
  runeBox(p.left, "first-only").click();
  p = panes(v, [], p.changes);
  sameFirst(p, "1/2", { "first-only": false, "first-two": true });
  assert.deepEqual(P.pendingOps(p.changes), [{ op: "addRuneset", ref: FIRST }, P.memberOp(FIRST, { library: "mine", id: "first-only" }, false)]);
  // the vault view's own box flips the same member back
  runeBox(p.right, "first-only").click();
  p = panes(v, [], p.changes);
  sameFirst(p, "2/2", { "first-only": true, "first-two": true });
});

test("picking First Only of an unjoined First stages First with only that member: 1/2 under First, never the Satchel", () => {
  const v = fresh();
  let p = panes(v);
  runeBox(p.left, "first-only").click();
  p = panes(v, [], p.changes);
  sameFirst(p, "1/2", { "first-only": true, "first-two": false });
  assert.equal(headBox(p.right, FIRST).getAttribute("aria-checked"), "true");
  assert.equal(p.right.querySelector(".runes-satchel"), null, "nothing loose to show");
  assert.deepEqual(P.pendingOps(p.changes), [{ op: "addRuneset", ref: FIRST }, P.memberOp(FIRST, { library: "mine", id: "first-two" }, false)]);
  // a second pick in the now joining First switches that member back on
  runeBox(p.left, "first-two").click();
  p = panes(v, [], p.changes);
  sameFirst(p, "2/2", { "first-only": true, "first-two": true });
  assert.deepEqual(P.pendingOps(p.changes), [{ op: "addRuneset", ref: FIRST }]);
});

/** The rune ids a runeset card lists in `root`. */
const idsOf = (root, s) => [...root.querySelectorAll(`details.runes-set[data-library="${s.library}"][data-runeset="${s.set}"] details.runes-rn`)].map((d) => d.dataset.id);

test("two runesets sharing a rune, both picked, saved, reloaded: both cards list it and read 2/2", () => {
  // the draft: both staged to join from the library heads
  const v = fresh();
  let p = panes(v);
  headBox(p.left, PAIR_A).click();
  p = panes(v, [], p.changes);
  headBox(p.left, PAIR_B).click();
  p = panes(v, [], p.changes);
  for (const s of [PAIR_A, PAIR_B]) assert.equal(countOf(p.right, s), "2/2", `the draft's ${s.set} count`);
  // saved and reloaded: rune_vault_read lists shared once (it loads once), under pair-a, with pair-b in `also`
  const saved = view(vault({ runesets: [{ source: BASE }, { source: PAIR_A }, { source: PAIR_B }] }), [
    ...["a", "b", "c"].map((id) => rune("base", id, BASE)),
    rune("pair", "pa", PAIR_A), { ...rune("pair", "shared", PAIR_A), also: [PAIR_B] }, rune("pair", "pb", PAIR_B)]);
  for (const readOnly of [false, true]) {
    const root = document.createElement("div");
    root.append(...vaultModify({ view: saved, removed: [], pending: null, busy: false, readOnly, card, trackOpen() {}, pick: async () => {},
      pend: staging(saved).pend, libraryRunes: library, librarySets: runesets }));
    assert.deepEqual(idsOf(root, PAIR_A).sort(), ["pa", "shared"], `pair-a lists shared (readOnly ${readOnly})`);
    assert.deepEqual(idsOf(root, PAIR_B).sort(), ["pb", "shared"], `pair-b lists shared (readOnly ${readOnly})`);
    if (!readOnly) for (const s of [PAIR_A, PAIR_B]) assert.equal(countOf(root, s), "2/2", `the saved ${s.set} count`);
    assert.equal(root.querySelector(".runes-satchel"), null, "shared never falls to the satchel");
  }
});

test("unticking a staged First drops its card on the right and every First entry", () => {
  const v = fresh();
  let p = panes(v);
  runeBox(p.left, "first-only").click();
  p = panes(v, [], p.changes);
  headBox(p.left, FIRST).click();
  p = panes(v, [], p.changes);
  agree(p);
  assert.equal(countOf(p.right, FIRST), null);
  assert.equal(countOf(p.left, FIRST), "0/2");
  assert.equal(p.changes.size, 0);
  assert.deepEqual(P.pendingOps(p.changes), []);
});
