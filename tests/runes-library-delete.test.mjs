// Delete Rune / Delete Library in Modify: the buttons ask, the confirm card carries the brief's text, Delete runs.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");
const { confirmText, without } = await import("../src/runes/bare/library-delete.ts");

const rune = (library, id) => ({ id, library, set: null, kind: "rule", activate: "", description: "D", section: [], recall: false, body: "b", drift: false });
const view = { vault: { id: "v", runesets: [], runes: [], lockedUtc: null }, runes: [], drift: [], warnings: [] };

function draw(extra = {}) {
  const calls = [];
  const root = document.createElement("div");
  root.append(...vaultModify({
    view, removed: [], pending: null, busy: false, card: { openInDocument: () => {}, note: () => {} },
    trackOpen: () => {}, edit: () => {}, pick: async () => {}, addRune: () => {},
    library: [rune("mine", "one"), rune("stock", "s1")],
    askDelete: (t) => calls.push(["ask", t]), confirmDelete: () => calls.push(["confirm"]), cancelDelete: () => calls.push(["cancel"]),
    ...extra,
  }));
  return { root, calls };
}
const labelled = (root, text) => [...root.querySelectorAll("button")].filter((b) => b.textContent === text);

test("a library rune and its library offer Delete; the stock library does not", () => {
  const { root, calls } = draw();
  const rune1 = labelled(root, "Delete Rune"), lib = labelled(root, "Delete Library");
  assert.equal(rune1.length, 1);
  assert.equal(lib.length, 1);
  rune1[0].click();
  lib[0].click();
  assert.deepEqual(calls, [["ask", { library: "mine", id: "one" }], ["ask", { library: "mine" }]]);
});

test("the confirm card says the brief's text and Delete and Cancel run their callbacks", () => {
  const { root, calls } = draw({ deleting: { library: "mine", id: "one" } });
  const card = root.querySelector(".runes-delete-confirm");
  assert.equal(card.querySelector(".blk-notice").textContent,
    "Delete one? It moves to the library backup. Unlocked vaults that hold it drop it; locked sessions keep their copy.");
  labelled(card, "Delete")[0].click();
  labelled(card, "Cancel")[0].click();
  assert.deepEqual(calls, [["confirm"], ["cancel"]]);
  const lib = draw({ deleting: { library: "mine" } }).root.querySelector(".blk-notice");
  assert.equal(lib.textContent, confirmText("Mine"));
});

test("Delete is the red decision button and Cancel the grey one", () => {
  const card = draw({ deleting: { library: "mine" } }).root.querySelector(".runes-delete-confirm");
  assert.ok(labelled(card, "Delete")[0].classList.contains("swap-yes"));
  assert.ok(labelled(card, "Cancel")[0].classList.contains("swap-no"));
});

test("a library placed only as runesets still offers Delete Library; stock does not", () => {
  const set = (library) => ({ library, set: "base" });
  const member = (library) => ({ ...rune(library, "m"), set: set(library) });
  const v = { vault: { id: "v", runesets: [{ source: set("kit") }, { source: set("kit-claude") }, { source: set("stock") }], runes: [], lockedUtc: null },
    runes: [member("kit"), member("kit-claude"), member("stock")], drift: [], warnings: [] };
  const { root, calls } = draw({ view: v, library: [] });
  const btns = labelled(root, "Delete Library");
  assert.equal(btns.length, 2);
  btns[0].click();
  assert.deepEqual(calls, [["ask", { library: "kit" }]]);
});

test("read-only Modify draws no delete action", () => {
  const { root } = draw({ readOnly: true, deleting: { library: "mine" } });
  assert.equal(labelled(root, "Delete Rune").length + labelled(root, "Delete Library").length, 0);
  assert.equal(root.querySelector(".runes-delete-confirm"), null);
});

test("without drops one rune or a whole library", () => {
  const l = [rune("a", "x"), rune("a", "y"), rune("b", "x")];
  assert.deepEqual(without(l, { library: "a", id: "x" }).map((r) => `${r.library}/${r.id}`), ["a/y", "b/x"]);
  assert.deepEqual(without(l, { library: "a" }).map((r) => `${r.library}/${r.id}`), ["b/x"]);
});
