// Delete Rune / Delete Runeset in the Rune Library (view-library.ts): Delete Rune on the rune's card, Delete Runeset at
// the end of an open runeset card (none on the Vidar or a template runeset, none on the Rune Satchel); each asks inline,
// the confirm carries the brief's text, Delete runs. A runeset delete leaves its runes in the library.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { libraryPane } = await import("../src/runes/bare/view-library.ts");
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");
const { runesetConfirmText, without, deletable } = await import("../src/runes/bare/library-delete.ts");
const P = await import("../src/runes/bare/vault-pending.ts");

const rune = (library, id) => ({ id, library, set: null, kind: "rule", activate: "", description: "D", section: [], recall: false, body: "b", drift: false, path: `${id}.md` });
const view = { vault: { id: "v", runesets: [], runes: [], lockedUtc: null }, runes: [], drift: [], warnings: [] };
const inert = { on: (_t, b) => b, pending: () => false, flip() {}, set() {}, count: 0, staged: () => [] };
const runesets = [
  { library: "mine", set: "team", members: [{ library: "mine", id: "one" }], fixed: false },
  { library: "vidar", set: "core", members: [{ library: "vidar", id: "s1" }], fixed: true },
];

function draw(extra = {}) {
  const calls = [];
  const root = document.createElement("div");
  root.append(...libraryPane({
    runes: [rune("mine", "one"), rune("vidar", "s1"), rune("mine", "loose")], runesets, view, changes: new Map(), pend: inert, still: false, busy: false,
    card: { openInDocument: () => {}, note: () => {} }, trackOpen: () => {}, deleting: null,
    askDelete: (t) => calls.push(["ask", t]), confirmDelete: () => calls.push(["confirm"]), cancelDelete: () => calls.push(["cancel"]),
    ...extra,
  }));
  return { root, calls };
}
const labelled = (root, text) => [...root.querySelectorAll("button")].filter((b) => b.textContent === text);
const setCard = (root, set) => root.querySelector(`.runes-lib-groups > details.runes-set[data-runeset="${set}"]`);

test("an import library's rune offers Delete Rune; a Vidar rune does not", () => {
  const { root, calls } = draw();
  const rune1 = labelled(root, "Delete Rune");
  assert.equal(rune1.length, 2, "mine/one and mine/loose");
  rune1[0].click();
  assert.deepEqual(calls, [["ask", { library: "mine", id: "one" }]]);
  assert.equal(labelled(root, "Delete Library").length, 0, "no whole-library delete");
  assert.equal(root.querySelector(".runes-lib-footer"), null, "no Libraries strip");
});

test("Delete Runeset sits at the end of its runeset card, after the kind groups; the Vidar runeset and the satchel have none", () => {
  const { root, calls } = draw();
  const del = labelled(root, "Delete Runeset");
  assert.equal(del.length, 1);
  const team = setCard(root, "team");
  assert.equal(del[0].closest("details.runes-set[data-runeset]"), team);
  assert.equal(team.lastElementChild, del[0].closest(".runes-set-acts"), "the card's last row");
  assert.equal(labelled(setCard(root, "core"), "Delete Runeset").length, 0, "a fixed runeset cannot be deleted");
  assert.equal(labelled(root.querySelector(".runes-satchel"), "Delete Runeset").length, 0, "the satchel is no runeset");
  del[0].click();
  assert.deepEqual(calls, [["ask", { library: "mine", id: "team", runeset: true }]]);
});

test("a rune's confirm sits on its own card, replacing its Delete Rune button, with the brief's text", () => {
  const { root, calls } = draw({ deleting: { library: "mine", id: "one" } });
  const confirms = root.querySelectorAll(".runes-delete-inline");
  assert.equal(confirms.length, 1);
  const row = confirms[0];
  const card = row.closest("details.runes-rn");
  assert.ok(card, "the row is inside the rune's card");
  assert.equal(card.open, true);
  assert.equal(row.previousElementSibling.tagName, "SUMMARY", "right under the card's head");
  assert.equal(row.querySelector(".runes-delete-text").textContent,
    "Delete one? It moves to the library backup. Unlocked vaults that hold it drop it; locked sessions keep their copy.");
  assert.equal(labelled(row.closest("details.runes-rn"), "Delete Rune").length, 0, "the button is replaced until answered");
  assert.deepEqual([...row.querySelectorAll("button")].map((b) => b.textContent), ["Delete", "Cancel"], "text left, then Delete, Cancel");
  labelled(row, "Delete")[0].click();
  labelled(row, "Cancel")[0].click();
  assert.deepEqual(calls, [["confirm"], ["cancel"]]);
});

test("deletable refuses the Vidar library and the rules library, whose runeset the store marks fixed", () => {
  const sets = [
    { library: "mine", set: "team", members: [], fixed: false },
    { library: "runes", set: "rules", members: [], fixed: true },
  ];
  assert.equal(deletable("vidar", sets), false);
  assert.equal(deletable("runes", sets), false);
  assert.equal(deletable("mine", sets), true);
});

test("a rules-library rune offers no Delete Rune", () => {
  const { root } = draw({
    runes: [rune("runes", "r1"), rune("mine", "one")],
    runesets: [{ library: "runes", set: "rules", members: [{ library: "runes", id: "r1" }], fixed: true }],
  });
  assert.equal(labelled(root, "Delete Rune").length, 1, "only mine/one");
});

test("the runeset confirm replaces Delete Runeset at the end of the opened card and says its runes stay", () => {
  const { root } = draw({ deleting: { library: "mine", id: "team", runeset: true } });
  const team = setCard(root, "team");
  assert.equal(team.open, true);
  const row = team.lastElementChild;
  assert.ok(row.classList.contains("runes-delete-confirm"));
  assert.equal(row.querySelector(".runes-delete-text").textContent, runesetConfirmText("Team"));
  assert.match(runesetConfirmText("Team"), /its runes stay in the library/);
  assert.equal(labelled(root, "Delete Runeset").length, 0);
  assert.equal(root.querySelectorAll(".runes-delete-confirm").length, 1, "a rune of the same id asks nothing");
});

test("Delete is the red decision button and Cancel the grey one, for a rune and a runeset", () => {
  for (const deleting of [{ library: "mine", id: "team", runeset: true }, { library: "mine", id: "one" }]) {
    const card = draw({ deleting }).root.querySelector(".runes-delete-confirm");
    assert.ok(labelled(card, "Delete")[0].classList.contains("swap-yes"));
    assert.ok(labelled(card, "Cancel")[0].classList.contains("swap-no"));
  }
});

test("the vault pane draws no delete action", () => {
  const root = document.createElement("div");
  root.append(...vaultModify({ view: { ...view, runes: [rune("mine", "one")], vault: { ...view.vault, runes: [{ library: "mine", id: "one" }] } },
    removed: [], pending: null, busy: false, card: { openInDocument: () => {}, note: () => {} }, trackOpen: () => {}, pick: async () => {}, pend: inert }));
  assert.equal(labelled(root, "Delete Rune").length + labelled(root, "Delete Runeset").length, 0);
});

test("without drops one rune", () => {
  const l = [rune("a", "x"), rune("a", "y"), rune("b", "x")];
  assert.deepEqual(without(l, { library: "a", id: "x" }).map((r) => `${r.library}/${r.id}`), ["a/y", "b/x"]);
});

test("forgetSet drops a deleted runeset's staged entries and keeps the rest", () => {
  const p = new Map();
  const s = { library: "mine", set: "team" };
  P.flip(p, { t: "set", source: s }, false);
  P.flip(p, { t: "member", set: s, rune: { library: "mine", id: "one" } }, true);
  P.flip(p, { t: "set", source: { library: "mine", set: "other" } }, false);
  P.flip(p, { t: "rune", library: "mine", id: "loose" }, false);
  P.forgetSet(p, s);
  assert.deepEqual([...p.values()].map((e) => e.target.t === "set" ? `set:${e.target.source.set}` : `${e.target.t}:${e.target.id}`), ["set:other", "rune:loose"]);
});
