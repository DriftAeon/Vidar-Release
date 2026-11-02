// Locked rows of the Vidar Runeset (src/runes/bare/view-vault.ts runeLock / lockedBox, view-library.ts): a required rune
// reads "Required" and a rune an on slot needs reads "Needed by <Name>.", both ticked, and neither takes a click. The
// Vidar Runeset's own head is locked the same way. Every other rune keeps its working box.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { vaultModify, LABEL_REQUIRED, TIP_REQUIRED } = await import("../src/runes/bare/view-vault.ts");
const { libraryPane } = await import("../src/runes/bare/view-library.ts");
const P = await import("../src/runes/bare/vault-pending.ts");

const VIDAR = { library: "vidar", set: "vidar" };
const rune = (id, extra = {}) =>
  ({ id, library: "vidar", set: VIDAR, kind: "rule", activate: "", description: "", section: [], recall: false, body: "", drift: false, path: `${id}.md`, ...extra });
const REQUIRED = rune("identity-claude", { item: { requiredByVidar: true } });
const NEEDED = rune("falcon-notes", { neededBy: "paths-scan" });
const FREE = rune("read-narrow");

function staging() {
  const changes = new Map();
  const pend = { on: (t, b) => P.effectiveOn(changes, t, b), pending: (t) => P.isPending(changes, t), flip: (t, b) => P.flip(changes, t, b),
    set: (ts, on) => { for (const x of ts) P.setWanted(changes, x.target, x.base, on); }, get count() { return changes.size; }, staged: () => [...changes.values()] };
  return { pend, changes, ops: () => P.pendingOps(changes) };
}

const view = {
  vault: { id: "v1", lockedUtc: null, runesets: [{ source: VIDAR }], runes: [] },
  drift: [], warnings: [], runes: [REQUIRED, NEEDED, FREE], off: [],
};
const card = { openInDocument() {}, note() {} };
const boxOf = (root, id) => root.querySelector(`[data-id="${id}"]`).previousElementSibling;

test("vault pane: a required row and a needed row are ticked, named, and ignore clicks", () => {
  const s = staging();
  const root = document.createElement("div");
  root.append(...vaultModify({ view, removed: [], pending: null, busy: false, readOnly: false, card, trackOpen() {}, pick: async () => {}, pend: s.pend }));
  const req = boxOf(root, "identity-claude");
  assert.equal(req.getAttribute("aria-label"), LABEL_REQUIRED);
  assert.equal(LABEL_REQUIRED, "Required");
  assert.equal(req.title, "Vidar needs this rune to run.");
  assert.equal(TIP_REQUIRED, "Vidar needs this rune to run.");
  assert.equal(req.getAttribute("aria-checked"), "true");
  const need = boxOf(root, "falcon-notes");
  assert.equal(need.getAttribute("aria-label"), "Needed by Paths Scan.");
  assert.equal(need.title, "Needed by Paths Scan.");
  assert.equal(need.getAttribute("aria-checked"), "true");
  for (const b of [req, need]) {
    assert.ok(b.disabled || b.getAttribute("aria-disabled") === "true", "the box is disabled");
    b.click();
  }
  assert.equal(s.changes.size, 0, "a click on either stages nothing");
  const free = boxOf(root, "read-narrow");
  free.click();
  assert.equal(s.changes.size, 1, "another Vidar rune still flips");
});

test("vault pane: the Vidar Runeset's head is locked Required", () => {
  const s = staging();
  const root = document.createElement("div");
  root.append(...vaultModify({ view, removed: [], pending: null, busy: false, readOnly: false, card, trackOpen() {}, pick: async () => {}, pend: s.pend }));
  const head = root.querySelector(`.runes-set[data-library="vidar"] > .runes-set-head > .runes-check`);
  assert.ok(head);
  assert.equal(head.getAttribute("aria-label"), "Required");
  head.click();
  assert.equal(s.changes.size, 0);
});

test("library pane: the same rows and the runeset head ignore clicks", () => {
  const s = staging();
  const root = document.createElement("div");
  root.append(...libraryPane({
    runes: [REQUIRED, NEEDED, FREE], runesets: [{ library: "vidar", set: "vidar", fixed: true, members: [REQUIRED, NEEDED, FREE].map((r) => ({ library: r.library, id: r.id })) }],
    view, changes: s.changes, pend: s.pend, still: false, busy: false, card, trackOpen: (d, _k, dflt) => { d.open = dflt; },
    deleting: null, askDelete() {}, confirmDelete() {}, cancelDelete() {},
  }));
  const head = root.querySelector(".runes-set-head > .runes-check");
  assert.equal(head.getAttribute("aria-label"), "Required");
  head.click();
  for (const id of ["identity-claude", "falcon-notes"]) boxOf(root, id).click();
  assert.equal(s.changes.size, 0, "no click on a locked row stages anything");
  assert.equal(boxOf(root, "falcon-notes").getAttribute("aria-label"), "Needed by Paths Scan.");
});
