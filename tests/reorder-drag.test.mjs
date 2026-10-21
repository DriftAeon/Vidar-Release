// Reorder drag (src/panels/reorder.ts): a press on a row name released off the list must end the
// pending press, so a later hover over the list (no button down) never becomes a drag that
// follows the pointer (regression). prefs and press load as in-memory stubs.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
});

const SRC = new URL("../src/", import.meta.url).href;
const STUBS = {
  prefs: `const m = new Map(); export function getPref(k) { return m.get(k); } export function setPref(k, v) { m.set(k, v); return true; } export function __seed(k, v) { m.set(k, v); }`,
  "panels/press": "export function repeatPress() {}",
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../src/prefs.ts") return { url: `data:text/javascript,${encodeURIComponent(STUBS.prefs)}`, shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC)) {
      const key = new URL(specifier, context.parentURL).href.slice(SRC.length).replace(/\.ts$/, "");
      if (Object.hasOwn(STUBS, key)) return { url: `data:text/javascript,${encodeURIComponent(STUBS[key])}`, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC) && !/\.\w+$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { applyOrder, enableReorder, moveOrder } = await import("../src/panels/reorder.ts");
const { __seed, getPref } = await import("../src/prefs.ts");

const fire = (el, type, init) => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));

test("a press released off the list does not turn a later hover into a drag", () => {
  const list = document.createElement("div");
  for (const k of ["a", "b", "c"]) {
    const row = document.createElement("div");
    row.className = "rack-row";
    row.dataset.key = k;
    const name = document.createElement("button");
    name.className = "rack-name";
    row.appendChild(name);
    list.appendChild(row);
  }
  document.body.replaceChildren(list);
  enableReorder(list, "order.rack");

  fire(list.querySelector(".rack-name"), "pointerdown", { button: 0, buttons: 1, clientY: 10 });
  fire(document.body, "pointerup", { button: 0, buttons: 0, clientY: 200 });
  fire(list.children[1], "pointermove", { buttons: 0, clientY: 40 });

  assert.equal(list.querySelector(".dragging"), null);
  assert.deepEqual([...list.children].map((r) => r.dataset.key), ["a", "b", "c"]);
});

test("axis x: a horizontal drag moves the tab by clientX and ignores clientY", () => {
  const list = document.createElement("div");
  ["a", "b", "c"].forEach((k, i) => {
    const tab = document.createElement("button");
    tab.className = "wb-tab";
    tab.dataset.key = k;
    tab.getBoundingClientRect = () => ({ left: i * 40, right: i * 40 + 40, width: 40, top: 0, bottom: 30, height: 30 });
    list.appendChild(tab);
  });
  document.body.replaceChildren(list);
  enableReorder(list, "order.workbenchTabs", { handle: ".wb-tab", axis: "x" });

  fire(list.children[0], "pointerdown", { button: 0, buttons: 1, clientX: 10, clientY: 10 });
  fire(list.children[0], "pointermove", { buttons: 1, clientX: 10, clientY: 200 }); // vertical only: no drag
  assert.equal(list.querySelector(".dragging"), null);
  fire(list.children[0], "pointermove", { buttons: 1, clientX: 70, clientY: 10 }); // over "b"'s right half
  fire(document.body, "pointerup", { button: 0, buttons: 0 });

  assert.deepEqual([...list.children].map((r) => r.dataset.key), ["b", "a", "c"]);
});

test("workbench drag saves visible tabs and preserves hidden tab slots", () => {
  const list = document.createElement("div");
  for (const [i, key] of ["a", "hidden", "b", "c"].entries()) {
    const tab = document.createElement("button");
    tab.className = "wb-tab";
    tab.dataset.key = key;
    if (key === "hidden") tab.style.display = "none";
    tab.getBoundingClientRect = () => ({ left: i * 40, right: i * 40 + 40, width: 40, top: 0, bottom: 30, height: 30 });
    list.appendChild(tab);
  }
  __seed("order.workbenchTabs", ["a", "hidden", "b", "c"]);
  document.body.replaceChildren(list);
  enableReorder(list, "order.workbenchTabs", {
    handle: ".wb-tab", axis: "x", visible: (row) => row.style.display !== "none",
  });

  fire(list.children[0], "pointerdown", { button: 0, buttons: 1, clientX: 10 });
  fire(list.children[0], "pointermove", { buttons: 1, clientX: 100 });
  fire(document.body, "pointerup", { button: 0, buttons: 0 });

  assert.deepEqual(getPref("order.workbenchTabs"), ["b", "a", "hidden", "c"]);
});

test("drag saves one copy of duplicate IDs and keeps unavailable saved slots", () => {
  const list = document.createElement("div");
  for (const k of ["a", "b", "c"]) {
    const row = document.createElement("div");
    row.className = "rack-row";
    row.dataset.key = k;
    const name = document.createElement("button");
    name.className = "rack-name";
    row.appendChild(name);
    row.getBoundingClientRect = () => ({ top: [...list.children].indexOf(row) * 40, bottom: ([...list.children].indexOf(row) + 1) * 40, height: 40, left: 0, right: 100, width: 100 });
    list.appendChild(row);
  }
  __seed("order.rack", ["a", "a", "hidden", "b", "unknown", "c"]);
  document.body.replaceChildren(list);
  enableReorder(list, "order.rack");

  fire(list.children[0].querySelector(".rack-name"), "pointerdown", { button: 0, buttons: 1, clientY: 10 });
  fire(list.children[0], "pointermove", { buttons: 1, clientY: 60 });
  fire(document.body, "pointerup", { button: 0, buttons: 0 });

  assert.deepEqual([...list.children].map((r) => r.dataset.key), ["b", "a", "c"]);
  assert.deepEqual(getPref("order.rack"), ["b", "unknown", "a", "hidden", "c"]);
});

test("applyOrder keeps the first duplicate and built-order fallback", () => {
  const list = document.createElement("div");
  for (const key of ["a", "b", "c", "d"]) {
    const row = document.createElement("div");
    row.dataset.key = key;
    list.appendChild(row);
  }
  __seed("order.tools", ["c", "c", "a", "unavailable"]);

  applyOrder(list, "order.tools");

  assert.deepEqual([...list.children].map((row) => row.dataset.key), ["c", "d", "a", "b"]);
  assert.deepEqual(getPref("order.tools"), ["c", "a", "unavailable"]);
});

test("moveOrder moves one visible slot and keeps unavailable saved entries", () => {
  const list = document.createElement("div");
  for (const k of ["a", "b", "c"]) {
    const row = document.createElement("div");
    row.dataset.key = k;
    list.appendChild(row);
  }
  __seed("order.tools", ["a", "hidden", "b", "unknown", "c"]);

  assert.equal(moveOrder(list, "order.tools", "b", 1), true);
  assert.deepEqual([...list.children].map((r) => r.dataset.key), ["a", "c", "b"]);
  assert.deepEqual(getPref("order.tools"), ["a", "hidden", "c", "b", "unknown"]);
});

test("moveOrder returns false at a boundary or when the key is missing", () => {
  const list = document.createElement("div");
  for (const k of ["a", "b"]) {
    const row = document.createElement("div");
    row.dataset.key = k;
    list.appendChild(row);
  }
  __seed("order.tools", ["a", "hidden", "b"]);

  assert.equal(moveOrder(list, "order.tools", "a", -1), false);
  assert.equal(moveOrder(list, "order.tools", "missing", 1), false);
  assert.deepEqual([...list.children].map((r) => r.dataset.key), ["a", "b"]);
  assert.deepEqual(getPref("order.tools"), ["a", "hidden", "b"]);
});
