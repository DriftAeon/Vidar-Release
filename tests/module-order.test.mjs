// mergeVisibleOrder (src/modules/order.ts) and its two writers: drag/keyboard (panels/reorder.ts)
// and the duplicate normalization in applyOrder.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement, CustomEvent: window.CustomEvent,
});

const SRC = new URL("../src/", import.meta.url).href;
const PREFS = `const m = new Map(); export function getPref(k) { return m.get(k); } export function setPref(k, v) { m.set(k, v); return true; } export function __seed(k, v) { m.set(k, v); }`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../prefs") return { url: `data:text/javascript,${encodeURIComponent(PREFS)}`, shortCircuit: true };
    if (specifier === "../src/prefs.ts") return { url: `data:text/javascript,${encodeURIComponent(PREFS)}`, shortCircuit: true };
    if (specifier === "./press" && context.parentURL?.startsWith(SRC)) {
      return { url: `data:text/javascript,${encodeURIComponent("export function repeatPress() {}")}`, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC) && !/\.\w+$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { mergeVisibleOrder } = await import("../src/modules/order.ts");
const { applyOrder, moveOrder } = await import("../src/panels/reorder.ts");
const { __seed, getPref } = await import("../src/prefs.ts");

function list(keys) {
  const el = document.createElement("div");
  for (const k of keys) { const r = document.createElement("div"); r.dataset.key = k; el.append(r); }
  document.body.replaceChildren(el);
  return el;
}
const keys = (el) => [...el.children].map((c) => c.dataset.key);

test("dormant ids keep their slot and relative order when visible ids move", () => {
  assert.deepEqual(mergeVisibleOrder(["a", "x", "y", "b"], ["b", "a"]), ["b", "a", "x", "y"]);
  assert.deepEqual(mergeVisibleOrder(["x", "a", "y", "b", "z"], ["a", "b"]), ["x", "a", "y", "b", "z"]);
  assert.deepEqual(mergeVisibleOrder(["a", "x", "y", "b"], ["a", "b"]), ["a", "x", "y", "b"]);
});

test("duplicates collapse; ids new to the saved list follow the visible order", () => {
  assert.deepEqual(mergeVisibleOrder(["a", "x", "a", "b"], ["b", "b", "a", "n"]), ["b", "a", "x", "n"]);
  assert.deepEqual(mergeVisibleOrder([], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(mergeVisibleOrder(["x", "y"], []), ["x", "y"]);
});

test("a drag/keyboard move leaves dormant ids in place", () => {
  __seed("order.tools", ["a", "x", "y", "b"]);
  const l = list(["a", "b"]);
  assert.equal(moveOrder(l, "order.tools", "b", -1), true);
  assert.deepEqual(getPref("order.tools"), ["b", "a", "x", "y"]);
  assert.equal(moveOrder(l, "order.tools", "b", 1), true);
  assert.deepEqual(getPref("order.tools"), ["a", "x", "y", "b"]);
});

test("applyOrder normalizes duplicate saved ids and announces the write", () => {
  __seed("order.tools", ["a", "b", "a"]);
  let events = 0;
  const on = () => { events++; };
  document.addEventListener("vidar-modules-change", on);
  try {
    applyOrder(list(["a", "b"]), "order.tools");
    assert.deepEqual(getPref("order.tools"), ["a", "b"]);
    assert.equal(events, 1);
    applyOrder(list(["a", "b"]), "order.tools");
    assert.equal(events, 1, "a clean list writes nothing");
  } finally { document.removeEventListener("vidar-modules-change", on); }
});

test("unknown saved ids and rows missing from the list are tolerated", () => {
  __seed("order.rack", ["gone", "b", "a"]);
  const l = list(["a", "b", "new"]);
  applyOrder(l, "order.rack");
  assert.deepEqual(keys(l), ["b", "new", "a"]); // new follows its built-order predecessor b
});
