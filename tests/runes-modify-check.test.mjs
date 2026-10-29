// Modify's checkbox: each rune bar's switch chip becomes a
// checkbox left of the bar, each head's switch a checkbox at its left, and a one-off library's head (Stock) batches
// its runes' ops into one edit (library-toggle.ts). Read mode keeps today's DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { vaultModify } = await import("../src/runes/bare/view-vault.ts");
const { libraryToggle } = await import("../src/runes/bare/library-toggle.ts");

const KIT = { library: "kit", set: "kit" };
const rune = (id, library, set = null, kind = "rule") =>
  ({ id, library, set, kind, activate: "", description: "", section: [], recall: false, body: "", drift: false });

function draw({ stockOn = ["a", "b"], readOnly = false, kitOn = true } = {}) {
  const view = {
    vault: { id: "v1", lockedUtc: null, runesets: kitOn ? [{ source: KIT }] : [],
      runes: stockOn.map((id) => ({ library: "stock", id })) },
    drift: [], warnings: [],
    runes: [...(kitOn ? [rune("tidy", "kit", KIT)] : []), ...stockOn.map((id) => rune(id, "stock"))],
    off: [...(kitOn ? [] : [rune("tidy", "kit", KIT)]), ...["a", "b"].filter((id) => !stockOn.includes(id)).map((id) => rune(id, "stock"))],
  };
  const sent = [];
  const root = document.createElement("div");
  root.append(...vaultModify({ view, removed: [], pending: null, busy: false, readOnly,
    card: { openInDocument() {}, note() {} }, trackOpen() {}, edit: (ops) => sent.push(ops), pick: async () => {} }));
  const card = (lib) => root.querySelector(`.runes-set[data-library="${lib}"]`);
  return { root, sent, card, headCheck: (lib) => card(lib).querySelector(":scope > .runes-set-head > .runes-check") };
}

test("Modify: the checkbox sits left of each rune bar, outside it, and the bar's end switch chip is gone", () => {
  const { root, sent } = draw();
  assert.equal(root.querySelectorAll(".runes-bare-switch").length, 0, "no switch chip anywhere in Modify");
  const rows = [...root.querySelectorAll(".runes-row")];
  assert.equal(rows.length, 3, "kit/tidy, stock/a, stock/b");
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
  assert.deepEqual(sent, [[{ op: "member", ref: { library: "kit", runeset: "kit", rune: { library: "kit", id: "tidy" }, on: false } }]]);
});

test("Modify: a runeset head's checkbox leads the head and keeps the runeset op; the cond slot is empty", () => {
  const { card, headCheck, sent } = draw();
  const head = card("kit").querySelector(":scope > .runes-set-head");
  assert.ok(head.classList.contains("has-check"));
  assert.equal(head.firstElementChild, headCheck("kit"));
  assert.equal(head.querySelector(".runes-cond").childElementCount, 0);
  assert.equal(headCheck("kit").title, "On\nAdds or removes this runeset in the tab's vault.");
  headCheck("kit").click();
  assert.deepEqual(sent, [[{ op: "removeRuneset", ref: KIT }]]);
});

test("Stock's head checkbox switches every rune of the library off as one edit", () => {
  const { headCheck, sent } = draw();
  const check = headCheck("stock");
  assert.ok(check, "Stock has a head checkbox");
  assert.equal(check.getAttribute("aria-checked"), "true");
  assert.equal(check.title, "On\nSwitches every rune of this library on or off in the tab's vault.");
  check.click();
  assert.deepEqual(sent, [[
    { op: "removeRune", ref: { library: "stock", id: "a" } },
    { op: "removeRune", ref: { library: "stock", id: "b" } },
  ]]);
});

test("Stock's head reads partial when some runes are on, and a click switches the rest on in one edit", () => {
  const { headCheck, sent } = draw({ stockOn: ["a"] });
  const check = headCheck("stock");
  assert.equal(check.getAttribute("aria-checked"), "mixed");
  assert.equal(check.getAttribute("aria-label"), "State: Some On");
  assert.equal(check.title, "Some On\nSwitches every rune of this library on or off in the tab's vault.");
  assert.ok(check.querySelector("path").getAttribute("d").startsWith("M3 6 H9"), "a dash, not a tick");
  check.click();
  assert.deepEqual(sent, [[{ op: "addRune", ref: { library: "stock", id: "b" } }]]);

  const none = draw({ stockOn: [] });
  assert.equal(none.headCheck("stock").getAttribute("aria-checked"), "false");
  assert.equal(none.headCheck("stock").querySelector("svg"), null, "off draws an empty box");
  none.headCheck("stock").click();
  assert.deepEqual(none.sent, [[
    { op: "addRune", ref: { library: "stock", id: "a" } },
    { op: "addRune", ref: { library: "stock", id: "b" } },
  ]]);
});

test("libraryToggle adds one output style at most, and an off style beside an on one leaves the head on", () => {
  const view = { vault: { id: "v1", runesets: [], runes: [] }, runes: [] };
  const st = (id, on) => ({ rune: rune(id, "stock", null, "output-style"), on });
  const r = (id, on) => ({ rune: rune(id, "stock"), on });
  assert.deepEqual(libraryToggle("stock", [st("s1", false), st("s2", false), r("x", false)], view).ops,
    [{ op: "addRune", ref: { library: "stock", id: "s1" } }, { op: "addRune", ref: { library: "stock", id: "x" } }]);
  const settled = libraryToggle("stock", [st("s1", true), st("s2", false), r("x", true)], view);
  assert.equal(settled.state, "on");
  assert.deepEqual(settled.ops, [{ op: "removeRune", ref: { library: "stock", id: "s1" } }, { op: "removeRune", ref: { library: "stock", id: "x" } }]);
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
