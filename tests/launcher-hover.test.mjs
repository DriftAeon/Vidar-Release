// Launcher flyouts: re-entering a row whose column is already open does not rebuild it, a sibling
// switch waits HOVER_SWITCH_MS and dies on mouseleave, and a column keeps the side it opened on.
// jsdom has no :hover, so cancellation is by mouseleave.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({ stubs: {
  "launcher/keyboard": `export let kbNav = false; export function colKeydown() {} export function kbPointerMove() {}
    globalThis.__setKbNav = (v) => { kbNav = v; };`,
} });
const { col, hoverOpen, hideColsFrom, placeColumn, setColumnRoot, HOVER_SWITCH_MS } = await import("../src/launcher/columns.ts");

const menu = document.createElement("div");
document.body.append(menu);
setColumnRoot(menu);
const enter = (row) => row.dispatchEvent(new window.Event("mouseenter"));
const leave = (row) => row.dispatchEvent(new window.Event("mouseleave"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function rows(n) {
  menu.innerHTML = "";
  return Array.from({ length: n }, () => menu.appendChild(document.createElement("button")));
}

test("re-entering a row whose column is open calls open 0 times", () => {
  const [a] = rows(2);
  let calls = 0;
  hoverOpen(a, 0, () => { calls++; });
  a.classList.add("open");
  col(0).classList.remove("hidden");
  enter(a);
  assert.equal(calls, 0);
});

test("with no sibling open the row opens now", () => {
  const [a] = rows(2);
  hideColsFrom(0);
  let calls = 0;
  hoverOpen(a, 0, () => { calls++; });
  enter(a);
  assert.equal(calls, 1);
});

test("switching from an open sibling waits, and mouseleave cancels it", async () => {
  const [a, b] = rows(2);
  a.classList.add("open");
  let calls = 0;
  hoverOpen(b, 0, () => { calls++; });
  enter(b);
  assert.equal(calls, 0, "not synchronous");
  await wait(HOVER_SWITCH_MS + 50);
  assert.equal(calls, 1, "fires after the delay");
  enter(b);
  leave(b);
  await wait(HOVER_SWITCH_MS + 50);
  assert.equal(calls, 1, "mouseleave before the delay cancels it");
});

test("a column keeps its side when re-placed for the same anchor", () => {
  const [a] = rows(1);
  const rect = (l, r, t = 0, b = 20) => ({ left: l, right: r, top: t, bottom: b, width: r - l, height: b - t });
  menu.getBoundingClientRect = () => rect(0, 200);
  a.getBoundingClientRect = () => rect(0, 200);
  window.innerWidth = 1000;
  window.innerHeight = 800;
  hideColsFrom(0);
  const c = col(0);
  Object.defineProperty(c, "offsetWidth", { configurable: true, value: 100 });
  placeColumn(0, a);
  assert.equal(c.dataset.flipped, "0");
  Object.defineProperty(c, "offsetWidth", { configurable: true, value: 900 });
  placeColumn(0, a);
  assert.equal(c.dataset.flipped, "0", "wider list does not flip the column");
  assert.ok(parseFloat(c.style.left) + 900 <= 1000 - 8 + 0.5, "clamped into the viewport");
});
