// The harness page scripts against the real Modify renderer (src/runes/bare/view-vault.ts vaultModify) in jsdom: a
// selector that drifts from the app fails here, not only in the driven run. No sandbox starts.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../../tests/helpers/dom-mount.mjs";

setupDom();
const { vaultModify } = await import("../../src/runes/bare/view-vault.ts");
const { libraryPane } = await import("../../src/runes/bare/view-library.ts");
const P = await import("../../src/runes/bare/vault-pending.ts");
const { ADD_RUNE_JS, DEL_LIB, DEL_SET, DELETE_JS, TOGGLE_RUNE_JS, shownDelIds } = await import("./runes-e2e-cases.mjs");
const { READ_JS } = await import("./runes-e2e.mjs");
const { DRAWN_WAIT } = await import("./runes-gen-leg.mjs");

const LIB = "runes-e2e";
const rune = (id, library = LIB) => ({ id, library, set: null, kind: "rule", activate: "", description: "", section: [], recall: false, body: "", drift: false, path: `${id}.md` });

/** Modify on an open vault holding one-off `e2e-review`, the Rune Library beside it offering `library` plus the held
 *  rune. Returns the staged ops Done would send, read at call time, and the delete asks. */
function mount(library = [rune("e2e-pinned")], runesets = []) {
  const view = { vault: { id: "copy-261031-000000-abcd", lockedUtc: null, runesets: [], runes: [{ library: LIB, id: "e2e-review" }] },
    runes: [rune("e2e-review")], drift: [], warnings: [] };
  const changes = new Map();
  const asks = [];
  const pend = { on: (t, b) => P.effectiveOn(changes, t, b), pending: (t) => P.isPending(changes, t), flip: (t, b) => P.flip(changes, t, b),
    set: (ts, on) => { for (const x of ts) P.setWanted(changes, x.target, x.base, on); }, get count() { return changes.size; }, staged: () => [...changes.values()] };
  const card = { openInDocument() {}, note() {} };
  const root = document.createElement("div");
  root.className = "runes-bare";
  root.append(...vaultModify({ view, removed: [], pending: null, busy: false, card, trackOpen() {}, pick: async () => {}, pend }));
  const lib = document.createElement("div");
  lib.className = "runes-bare runes-library";
  lib.append(...libraryPane({ runes: [rune("e2e-review"), ...library], runesets, view, changes, pend, still: false, busy: false, card, trackOpen() {},
    deleting: null, askDelete: (t) => asks.push(t), confirmDelete() {}, cancelDelete() {} }));
  document.body.replaceChildren(root, lib);
  return { ops: () => P.pendingOps(changes), asks };
}
const page = (js) => new Function("document", `return ${js}`)(document);

test("Modify draws no switch inside a rune card: the old selector finds nothing (cases 2 and 5)", () => {
  mount();
  assert.equal(document.querySelector('details.runes-rn[data-id="e2e-review"] .runes-bare-switch'), null);
  assert.ok(document.querySelector('.runes-row > .runes-check + details.runes-rn[data-id="e2e-review"]'));
});

test("Add Rune ticks the Rune Library row and leaves an on rune alone", async () => {
  const m = mount();
  assert.deepEqual(await page(ADD_RUNE_JS("e2e-pinned")), { ok: true, id: "e2e-pinned" });
  assert.deepEqual(m.ops().map((o) => [o.op, o.ref.id]), [["addRune", "e2e-pinned"]]);
  assert.deepEqual(await page(ADD_RUNE_JS("e2e-review")), { ok: true, already: true, id: "e2e-review" });
  assert.equal(m.ops().length, 1);
});

test("Toggle clicks the vault pane's one-off checkbox, not the library row, taking the rune out (case 3)", async () => {
  const m = mount();
  assert.deepEqual(await page(TOGGLE_RUNE_JS("e2e-review")), { ok: true, id: "e2e-review" });
  assert.deepEqual(m.ops().map((o) => [o.op, o.ref.id]), [["removeRune", "e2e-review"]]);
  assert.equal(document.querySelector('.runes-library .runes-check[data-keep="lib:runes-e2e/e2e-review"]').getAttribute("aria-checked"), "true",
    "the library row is untouched until a repaint");
});

test("Delete asks through the Rune Library: Delete Rune on the card, Delete Runeset at the end of its runeset card (case 11)", async () => {
  const m = mount([rune("del-a", DEL_LIB), rune("del-b", DEL_LIB)], [{ library: DEL_LIB, set: DEL_SET, members: [{ library: DEL_LIB, id: "del-b" }], fixed: false }]);
  // the confirm card is the app's to draw after the ask: the page script stops at its 8 s wait, so only the ask is read here
  const run = (js) => page(js.replace("Date.now() + 8000", "Date.now() + 50"));
  assert.deepEqual(await run(DELETE_JS(DEL_LIB, "del-a")), { ok: false, why: "confirm card absent" });
  assert.deepEqual(await run(DELETE_JS(DEL_LIB, DEL_SET, true)), { ok: false, why: "confirm card absent" });
  assert.deepEqual(m.asks, [{ library: DEL_LIB, id: "del-a" }, { library: DEL_LIB, id: DEL_SET, runeset: true }]);
  assert.deepEqual(page(READ_JS).librarySets, [{ set: DEL_SET, library: DEL_LIB }]);
});

test("the read-back names a Rune Library row's library from the card, past the kind head (case 11)", async () => {
  mount([rune("del-a", DEL_LIB), rune("del-b", DEL_LIB)]);
  // the kind head is the nearest .runes-set and has no data-library: the card carries its own
  const kindHead = document.querySelector('.runes-library details.runes-rn[data-id="del-b"]').closest(".runes-set");
  assert.equal(kindHead.dataset.library, undefined);
  const r = page(READ_JS);
  assert.deepEqual(shownDelIds(r), ["del-a", "del-b"]);
  assert.deepEqual(r.runes.map((x) => [x.id, x.library]), [["e2e-review", LIB]], "the vault pane only");
  // case 8's drawn wait reads the vault pane: library rows do not count as drawn
  assert.equal(await page(DRAWN_WAIT(LIB)), true);
  assert.equal(await page(DRAWN_WAIT(DEL_LIB).replace(/Date\.now\(\)\+\d+/, "Date.now()+50")), false);
});

test("the read-back takes each rune's state from its Modify checkbox", () => {
  mount();
  const r = page(READ_JS);
  assert.deepEqual(r.runes.map((x) => [x.id, x.state, x.switch]), [["e2e-review", "On", true]]);
  assert.deepEqual(r.libraryRows.map((x) => [x.id, x.on]), [["e2e-pinned", false], ["e2e-review", true]]);
});
