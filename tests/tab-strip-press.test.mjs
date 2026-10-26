// Session tabs act on press (tab-strip.ts buildTabButton): pointerdown activates once, the trailing
// click does not, a press on the close X does not select, a keyboard click does, and mousedown is
// cancelled so the pane keeps the focus activate() gave it. Same resolve-hook harness as
// tab-menu-probe.test.mjs.
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
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.hasPointerCapture = () => false;
window.HTMLElement.prototype.releasePointerCapture = () => {};

const SRC = new URL("../src/", import.meta.url).href;
const STUBS = {
  ipc: "export function invoke() { return Promise.resolve(null); }",
  "panels/sessions/astra-bridge": `export function armAstra() {} export function armBlocker() { return null; }
    export function disarmAstra() {} export function isArmed() { return false; }`,
  "panels/sessions/codex-save": "export function saveCodexTabs() {}",
  "panels/sessions/pair": "export function forgetPair() {}",
  "panels/sessions/gateway-art": "export function mayActAsPlainClaude() { return true; }",
  "panels/sessions/lookup": "export function hostedFalconSession() { return Promise.resolve(null); }",
  "launcher/hosted-names-pref": "export const hostedNames = { remember() {} };",
  "panels/sessions/tab-row-paint": `export function tabRowSlot(cls) { const s = document.createElement("span"); s.className = cls; return s; }
    export function buildRightColumn() { const d = document.createElement("div"); d.className = "tab-rc"; return d; }`,
  "panels/sessions/tab-state-format": "export function tabTitleCase(s) { return s; }",
  "panels/sessions/tab-agents": "export function initTabAgents() { return () => {}; } export function moveTabFamily() {}",
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) return { url: `data:text/javascript,${encodeURIComponent("export {};")}`, shortCircuit: true };
    if (specifier.endsWith(".png")) return { url: `data:text/javascript,${encodeURIComponent("export default '';")}`, shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC)) {
      const url = new URL(specifier, context.parentURL);
      const key = url.href.slice(SRC.length).replace(/\.ts$/, "");
      if (Object.hasOwn(STUBS, key)) return { url: `data:text/javascript,${encodeURIComponent(STUBS[key])}`, shortCircuit: true };
      if (["launcher/agent-kind", "panels/sessions/body-kind", "modules/context-menu", "modules/place-menu", "panels/press"].includes(key)) return next(`${url.href}.ts`, context);
    }
    return next(specifier, context);
  },
});

const strip = await import("../src/panels/sessions/tab-strip.ts");

const activated = [];
const closed = [];
const sessionMap = new Map();
let activeId = null;
let dispatchInActivate = false;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
strip.bindTabStrip({
  sessions: sessionMap,
  view: () => ({ visible: [], activeId, workbenchOpen: false }),
  activate: (id) => {
    activated.push(id);
    if (dispatchInActivate) { activeId = id; document.dispatchEvent(new window.CustomEvent("vidar-focus")); }
  },
  closeSession: (id) => { closed.push(id); },
  openDual() {}, openWorkbench() {}, collapseWorkbench() {},
  jettisonSession: async () => {}, closeHostedTab: async () => {},
  dispatchFocus() {}, focusBody() {},
});
const host = document.createElement("div");
document.body.appendChild(host);
strip.initTabStrip(host);
const button = strip.buildTabButton("t1", undefined, 1);
const closeX = button.querySelector(".session-close");
test("the close X is a labelled button", () => {
  assert.equal(closeX.getAttribute("role"), "button");
  assert.equal(closeX.getAttribute("aria-label"), "Close Tab");
  assert.equal(closeX.title, "Close Tab");
});
const fire = (el, type, init = {}) => {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
};
const reset = () => { activated.length = 0; closed.length = 0; };

test("pointerdown selects once and the trailing click does not select again", () => {
  reset();
  fire(button, "pointerdown");
  assert.deepEqual(activated, ["t1"], "activates on press");
  fire(button, "click");
  assert.deepEqual(activated, ["t1"], "the click after a press is swallowed");
});

test("a keyboard click (no pointerdown) selects", () => {
  reset();
  fire(button, "click");
  assert.deepEqual(activated, ["t1"]);
});

test("a press on the close X does not select; its click closes once", () => {
  reset();
  fire(closeX, "pointerdown");
  fire(closeX, "click");
  assert.deepEqual(activated, []);
  assert.deepEqual(closed, ["t1"]);
});

test("mousedown is cancelled so focus stays in the pane", () => {
  assert.equal(fire(button, "mousedown").defaultPrevented, true);
});

test("cycling to an out-of-view tab scrolls the strip; a press or an unchanged id does not", async () => {
  const wait = () => new Promise((r) => setTimeout(r, 5));
  const second = strip.buildTabButton("t2", undefined, 2);
  sessionMap.set("t1", { button });
  sessionMap.set("t2", { button: second });
  host.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
  second.getBoundingClientRect = () => ({ top: 130, bottom: 160 });
  host.scrollTop = 0;
  activeId = "t2";
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await wait();
  assert.equal(host.scrollTop, 60, "scrolled by how far the tab's bottom sat past the strip");
  host.scrollTop = 0;
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  await wait();
  assert.equal(host.scrollTop, 0, "same id again leaves a manual scroll alone");
  activeId = "t1";
  document.dispatchEvent(new window.CustomEvent("vidar-focus"));
  dispatchInActivate = true;
  fire(second, "pointerdown"); // activate() dispatches vidar-focus with t2 active, as layout() does
  await wait();
  dispatchInActivate = false;
  assert.equal(host.scrollTop, 0, "a press on the tab leaves the strip where it is");
});

test("a drag-end flag never eats the next press", () => {
  reset();
  button.dataset.dragged = "1"; // what the drag handler leaves after a reorder
  fire(button, "pointerdown");
  assert.deepEqual(activated, ["t1"]);
  fire(button, "click");
});
