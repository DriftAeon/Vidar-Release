// popover.ts contract (src/modules/popover.ts): inside() and anchor mousedowns keep it open, a
// defaultPrevented Escape does not close, Escape restores focus, a second open closes the first,
// persistent mode hides instead of removing, point placement clamps; plus place-menu's Placers.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom();
const { openPopover, closeOpenPopover } = await import("../src/modules/popover.ts");
const { placeAbove, placeBeside } = await import("../src/modules/place-menu.ts");

const down = (el) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
function fixture() {
  const anchor = document.createElement("button");
  const outside = document.createElement("div");
  const nested = document.createElement("div");
  const el = document.createElement("div");
  const row = document.createElement("button");
  el.append(row);
  document.body.append(anchor, outside, nested);
  return { anchor, outside, nested, el, row };
}

test("popover: inside() and anchor mousedowns keep it open; an outside one closes once", () => {
  const before = dom.ledger.count();
  const { anchor, outside, nested, el } = fixture();
  const reasons = [];
  openPopover({ el, anchor, inside: () => [nested], onClose: (r) => reasons.push(r) });
  assert.equal(el.parentNode, document.body);
  down(nested);
  assert.ok(el.isConnected, "inside() node keeps it open");
  down(anchor);
  assert.ok(el.isConnected, "anchor mousedown keeps it open (its click toggles)");
  down(el.firstChild);
  assert.ok(el.isConnected, "a mousedown in the popover keeps it open");
  down(outside);
  assert.equal(el.isConnected, false);
  assert.deepEqual(reasons, ["outside"]);
  assert.equal(dom.ledger.count(), before, "document listeners gone after close");
  down(outside);
  assert.deepEqual(reasons, ["outside"], "onClose runs once");
});

test("popover: a defaultPrevented Escape does not close; a plain one closes and restores focus", () => {
  const { anchor, el, row } = fixture();
  const keys = [];
  openPopover({ el, anchor, restoreFocus: anchor, onKey: (e) => keys.push(e.key) });
  const prevent = (e) => e.preventDefault();
  row.addEventListener("keydown", prevent);
  key(row, "Escape");
  assert.ok(el.isConnected, "a handled Escape leaves it open");
  row.removeEventListener("keydown", prevent);
  key(row, "ArrowDown");
  assert.deepEqual(keys, ["ArrowDown"], "other keys reach onKey");
  row.focus();
  key(row, "Escape");
  assert.equal(el.isConnected, false);
  assert.equal(document.activeElement, anchor, "focus restored to restoreFocus");
});

test("popover: restoreFocus as a function runs on close(true), not on close()", () => {
  const { el } = fixture();
  let n = 0;
  const close = openPopover({ el, restoreFocus: () => { n++; } });
  close(true);
  assert.equal(n, 1);
  const { el: el2 } = fixture();
  openPopover({ el: el2, restoreFocus: () => { n++; } })();
  assert.equal(n, 1);
});

test("popover: a second open closes the first", () => {
  const before = dom.ledger.count();
  const a = fixture(), b = fixture();
  const reasons = [];
  openPopover({ el: a.el, onClose: (r) => reasons.push(`a:${r}`) });
  const closeB = openPopover({ el: b.el, onClose: (r) => reasons.push(`b:${r}`) });
  assert.equal(a.el.isConnected, false);
  assert.ok(b.el.isConnected);
  assert.deepEqual(reasons, ["a:replaced"]);
  closeB();
  assert.deepEqual(reasons, ["a:replaced", "b:closed"]);
  closeOpenPopover();
  assert.equal(dom.ledger.count(), before);
});

test("popover: persistent mode hides rather than removes; document keys reach Escape", () => {
  const { anchor, outside, el } = fixture();
  el.className = "hidden";
  document.body.append(el);
  let focused = 0;
  openPopover({ el, anchor, persistent: true, keys: "document", restoreFocus: () => { focused++; } });
  assert.equal(el.classList.contains("hidden"), false);
  down(outside);
  assert.ok(el.isConnected, "kept in the DOM");
  assert.ok(el.classList.contains("hidden"));
  openPopover({ el, anchor, persistent: true, keys: "document", restoreFocus: () => { focused++; } });
  assert.equal(el.classList.contains("hidden"), false);
  key(outside, "Escape");
  assert.ok(el.isConnected && el.classList.contains("hidden"));
  assert.equal(focused, 1);
});

test("popover: point placement clamps x and y inside the window", () => {
  const { el } = fixture();
  Object.defineProperty(el, "offsetWidth", { value: 200 });
  Object.defineProperty(el, "offsetHeight", { value: 100 });
  const vw = window.innerWidth, vh = window.innerHeight;
  const close = openPopover({ el, place: { x: vw - 10, y: vh - 10 } });
  assert.equal(el.style.left, `${vw - 200 - 8}px`);
  assert.equal(el.style.top, `${vh - 100 - 8}px`);
  close();
  openPopover({ el, place: { x: 40, y: 50 } });
  assert.equal(el.style.left, "40px");
  assert.equal(el.style.top, "50px");
  closeOpenPopover();
});

test("placeAbove: 4px above the bar, start or end aligned, x clamped", () => {
  const rect = { left: 100, right: 160, top: 770, bottom: 790 };
  const bar = { left: 0, right: 1200, top: 760, bottom: 800 };
  assert.deepEqual(placeAbove(rect, bar, "start")(150, 120, 1200, 800), { left: 100, top: 636 });
  assert.deepEqual(placeAbove(rect, bar, "end")(150, 120, 1200, 800), { left: 10, top: 636 });
  assert.deepEqual(placeAbove(rect, bar, "end")(200, 120, 1200, 800), { left: 8, top: 636 });
  assert.deepEqual(placeAbove(rect, bar, "start")(150, 900, 1200, 800), { left: 100, top: 8 });
});

test("placeBeside: 6px past the further of the rect and the edge, top clamped", () => {
  const rect = { left: 4, right: 40, top: 700, bottom: 730 };
  assert.deepEqual(placeBeside(rect, 44)(200, 300, 1200, 800), { left: 50, top: 492 });
  assert.deepEqual(placeBeside(rect, 0)(200, 50, 1200, 800), { left: 46, top: 700 });
});
