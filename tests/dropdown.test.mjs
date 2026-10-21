// dropdown.ts contract (src/panels/dropdown.ts): outside mousedown closes, a mousedown in an
// `inside()` node does not, Escape closes unless a nested menu already handled it
// (defaultPrevented), Tab refocuses the button and closes, and close drops every document listener.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom();
const { dropdown } = await import("../src/panels/dropdown.ts");

function mount(extra = {}) {
  const button = document.createElement("button");
  const outside = document.createElement("div");
  const nested = document.createElement("div");
  document.body.append(button, outside, nested);
  const dd = dropdown({
    button,
    anchor: button,
    build: (m) => { m.replaceChildren(); const row = document.createElement("button"); row.className = "row"; m.append(row); },
    inside: () => [nested],
    ...extra,
  });
  const row = () => document.querySelector(".row");
  return { button, outside, nested, dd, row };
}
const down = (el) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

test("dropdown: an outside mousedown closes; one inside an inside() node does not", () => {
  const before = dom.ledger.count();
  const { outside, nested, dd } = mount();
  dd.open();
  assert.equal(dd.isOpen(), true);
  assert.ok(document.querySelector(".row"), "menu built on open");
  down(nested);
  assert.equal(dd.isOpen(), true, "inside() node keeps it open");
  down(outside);
  assert.equal(dd.isOpen(), false);
  assert.equal(document.querySelector(".row"), null, "menu removed on close");
  assert.equal(dom.ledger.count(), before, "document listeners gone after close");
  assert.doesNotThrow(() => down(outside), "a second outside mousedown is a no-op");
  assert.equal(dd.isOpen(), false);
});

test("dropdown: Escape with defaultPrevented does not close; without it closes and refocuses", () => {
  const { button, dd, row } = mount();
  dd.open();
  const r = row();
  const prevent = (e) => e.preventDefault();
  r.addEventListener("keydown", prevent);
  key(r, "Escape");
  assert.equal(dd.isOpen(), true, "a handled Escape leaves the menu open");
  r.removeEventListener("keydown", prevent);
  r.focus();
  key(r, "Escape");
  assert.equal(dd.isOpen(), false);
  assert.equal(document.activeElement, button);
});

test("dropdown: Tab refocuses the button, then closes, without preventDefault", () => {
  const { button, dd, row } = mount();
  dd.open();
  const r = row();
  r.focus();
  let focusedWhileOpen = null;
  button.addEventListener("focus", () => { focusedWhileOpen = dd.isOpen(); }, { once: true });
  const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  r.dispatchEvent(ev);
  assert.equal(focusedWhileOpen, true, "button focused before the close");
  assert.equal(dd.isOpen(), false);
  assert.equal(document.activeElement, button);
  assert.equal(ev.defaultPrevented, false, "native Tab still moves focus on");
});

test("dropdown: ArrowDown on the button opens; other menu keys reach onKey; rerender rebuilds in place", () => {
  const keys = [];
  let entered = null;
  const { button, dd, row } = mount({ onKey: (e) => keys.push(e.key), enter: (_m, byKey) => { entered = byKey; } });
  key(button, "ArrowDown");
  assert.equal(dd.isOpen(), true);
  assert.equal(entered, true);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  key(row(), "ArrowUp");
  assert.deepEqual(keys, ["ArrowUp"]);
  const first = row();
  dd.rerender();
  assert.notEqual(row(), first, "rows rebuilt");
  assert.equal(document.querySelectorAll(".row").length, 1);
  dd.close();
  assert.equal(button.getAttribute("aria-expanded"), "false");
});
