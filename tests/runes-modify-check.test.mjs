// Modify's checkbox: each rune bar's switch chip becomes a
// checkbox left of the bar, each head's switch a checkbox at its left, and the Rune Satchel's head holds
// no switch. Read mode keeps today's DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");
const P = await import("../src/runes/bare/vault-pending.ts");

/** A staged-changes control over a fresh map, and the ops Done would send from it. */
function staging() {
  const changes = new Map();
  const pend = { on: (t, b) => P.effectiveOn(changes, t, b), pending: (t) => P.isPending(changes, t), flip: (t, b) => P.flip(changes, t, b),
    set: (ts, on) => { for (const x of ts) P.setWanted(changes, x.target, x.base, on); }, get count() { return changes.size; }, staged: () => [...changes.values()] };
  return { pend, ops: () => P.pendingOps(changes) };
}

const INST = { library: "installed", set: "installed" };
const rune = (id, library, set = null, kind = "rule") =>
  ({ id, library, set, kind, activate: "", description: "", section: [], recall: false, body: "", drift: false });

function draw({ baseOn = ["a", "b"], readOnly = false, kitOn = true } = {}) {
  const view = {
    vault: { id: "v1", lockedUtc: null, runesets: kitOn ? [{ source: INST }] : [],
      runes: baseOn.map((id) => ({ library: "base", id })) },
    drift: [], warnings: [],
    runes: [...(kitOn ? [rune("tidy", "installed", INST)] : []), ...baseOn.map((id) => rune(id, "base"))],
    off: [...(kitOn ? [] : [rune("tidy", "installed", INST)]), ...["a", "b"].filter((id) => !baseOn.includes(id)).map((id) => rune(id, "base"))],
  };
  const s = staging();
  const root = document.createElement("div");
  const paint = () => root.replaceChildren(...vaultModify({ view, removed: [], pending: null, busy: false, readOnly,
    card: { openInDocument() {}, note() {} }, trackOpen() {}, pick: async () => {}, pend: s.pend }));
  paint();
  const card = (lib) => root.querySelector(`.runes-set[data-library="${lib}"]`);
  return { root, sent: s.ops, paint, card, headCheck: (lib) => card(lib)?.querySelector(":scope > .runes-set-head > .runes-check") };
}

test("Modify: the checkbox sits left of each rune bar, outside it, and the bar's end switch chip is gone", () => {
  const { root, sent } = draw();
  assert.equal(root.querySelectorAll(".runes-bare-switch").length, 0, "no switch chip anywhere in Modify");
  const rows = [...root.querySelectorAll(".runes-row")];
  assert.equal(rows.length, 3, "installed/tidy, base/a, base/b");
  for (const row of rows) {
    const [check, card] = row.children;
    assert.equal(check.className, "runes-check");
    assert.equal(card.className.split(" ")[0], "runes-rn");
    assert.equal(card.querySelector(".runes-check"), null, "the checkbox is not inside the bar");
    assert.equal(check.getAttribute("role"), "checkbox");
    assert.equal(check.getAttribute("aria-checked"), "true");
    assert.equal(check.getAttribute("aria-label"), "State: On");
  }
  const tidy = root.querySelector('[data-id="tidy"]').previousElementSibling;
  assert.equal(tidy.title, "On\nChanges this vault's copy of the runeset; the library runeset stays as it is.");
  tidy.click();
  assert.deepEqual(sent(), [{ op: "member", ref: { library: "installed", runeset: "installed", rune: { library: "installed", id: "tidy" }, on: false } }]);
});

test("Modify: a runeset head's checkbox leads the head and keeps the runeset op; the cond slot is empty", () => {
  const { card, headCheck, sent } = draw();
  const head = card("installed").querySelector(":scope > .runes-set-head");
  assert.ok(head.classList.contains("has-check"));
  assert.equal(head.firstElementChild, headCheck("installed"));
  assert.equal(head.querySelector(".runes-cond").childElementCount, 0);
  assert.equal(headCheck("installed").title, "On\nAdds or removes this runeset in the tab's vault.");
  headCheck("installed").click();
  assert.deepEqual(sent(), [{ op: "removeRuneset", ref: INST }]);
});

test("the Rune Satchel holds the loose runes on one card: an empty head slot, no switch, each row its own library", () => {
  const { root, card, sent } = draw();
  const sat = root.querySelector(".runes-satchel");
  assert.equal(sat.querySelector(":scope > .runes-set-head .runes-sn").textContent, "Rune Satchel");
  assert.equal(card("base"), null, "no card per library");
  assert.equal(sat.dataset.library, undefined);
  assert.equal(sat.querySelector(":scope > .runes-set-head > .runes-check"), null, "the head has no switch");
  assert.ok(sat.querySelector(":scope > .runes-set-head .runes-check-slot"), "the head holds the empty slot");
  assert.deepEqual([...sat.querySelectorAll("details.runes-rn")].map((d) => `${d.dataset.library}/${d.dataset.id}`), ["base/a", "base/b"]);
  // a row's own switch stages its own op
  root.querySelector('[data-id="a"]').previousElementSibling.click();
  assert.deepEqual(sent(), [{ op: "removeRune", ref: { library: "base", id: "a" } }]);
});

test("Modify hides a switched-off loose rune: the Rune Library offers it", () => {
  const { root } = draw({ baseOn: ["a"] });
  assert.ok(root.querySelector('[data-id="a"]'));
  assert.equal(root.querySelector('[data-id="b"]'), null);
  assert.equal(draw({ baseOn: [] }).root.querySelector(".runes-satchel"), null, "with every loose rune off there is no Satchel");
});

test("Read mode is unchanged: no checkbox, no row wrapper, and an off runeset's runes keep the switch chip", () => {
  const on = draw({ readOnly: true });
  assert.equal(on.root.querySelector(".runes-check, .runes-row, .runes-check-slot, .has-check"), null);
  assert.equal(on.root.querySelectorAll(".runes-bare-switch").length, 0);
  const off = draw({ readOnly: true, kitOn: false });
  const chip = off.root.querySelector('[data-id="tidy"] .runes-bare-switch');
  assert.ok(chip, "the disabled chip stays at the bar's end");
  assert.equal(chip.disabled, true);
  assert.equal(off.root.querySelector(".runes-check"), null);
});
