// Shared jsdom harness for panel mount tests (not a test itself: the npm glob is *.test.mjs).
// setupDom() must run before any src import: it installs the DOM globals and a process-global
// resolve hook (extensionless src imports -> .ts, CSS/assets -> empty modules, `stubs` keys
// -> data: modules, keyed by the src-relative path without .ts, e.g. "ipc", "panels/sessions").
// The `ipc` stub answers invoke() from `answers` (value or function of args), rejects anything
// unstubbed, and captures listen() handlers. The ledger counts window/document listeners
// still attached (a {signal} abort counts as a removal); the ResizeObserver fake records
// observe/disconnect so a test can see an observer left running.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const SRC = new URL("../../src/", import.meta.url).href;
const EMPTY = "data:text/javascript,";

const IPC_STUB = `export function invoke(cmd, args) {
    const h = globalThis.__domMount; h.invoked.push(cmd);
    if (Object.hasOwn(h.answers, cmd)) { const a = h.answers[cmd]; return Promise.resolve(typeof a === "function" ? a(args) : a); }
    return Promise.reject(new Error("unstubbed invoke: " + cmd));
  }
  export function listen(ev, cb) { const h = globalThis.__domMount; h.invoked.push("listen:" + ev); h.listeners[ev] = cb; return Promise.resolve(() => {}); }`;

const GLOBALS = ["Node", "Element", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement",
  "HTMLSelectElement", "HTMLDivElement", "SVGElement", "SVGSVGElement", "Text", "Range", "DocumentFragment",
  "DOMParser", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent",
  "FocusEvent", "localStorage", "location", "navigator"];

function ledgerFor(targets) {
  const active = new Set();
  const keyOf = (target, type, fn, opts) => `${targets.indexOf(target)}|${type}|${typeof opts === "boolean" ? opts : !!opts?.capture}`;
  const find = (key, fn) => [...active].find((e) => e.key === key && e.fn === fn);
  for (const target of targets) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, fn, opts) => {
      add(type, fn, opts);
      if (!fn) return;
      const key = keyOf(target, type, fn, opts);
      if (find(key, fn)) return; // the DOM ignores a duplicate registration too
      const entry = { key, fn, type };
      active.add(entry);
      opts?.signal?.addEventListener("abort", () => active.delete(entry), { once: true });
      if (opts?.once) add(type, () => active.delete(entry), { once: true, capture: !!opts.capture });
    };
    target.removeEventListener = (type, fn, opts) => {
      remove(type, fn, opts);
      const e = find(keyOf(target, type, fn, opts), fn);
      if (e) active.delete(e);
    };
  }
  return {
    count: () => active.size,
    types: () => [...active].map((e) => e.type).sort(),
  };
}

export function setupDom({ stubs = {}, answers = {} } = {}) {
  const { window } = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://vidar.test/" });
  for (const k of GLOBALS) if (window[k] !== undefined && globalThis[k] === undefined) {
    try { globalThis[k] = window[k]; } catch { /* read-only node global (navigator): keep node's */ }
  }
  const observers = [];
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb; this.observed = 0; this.disconnected = false; observers.push(this); }
    observe() { this.observed++; }
    unobserve() {}
    disconnect() { this.disconnected = true; }
  }
  window.ResizeObserver = FakeResizeObserver;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  Object.assign(globalThis, {
    window,
    document: window.document,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: FakeResizeObserver,
    matchMedia: window.matchMedia,
  });

  const ipc = { invoked: [], answers: { ...answers }, listeners: {} };
  globalThis.__domMount = ipc;
  const STUBS = { ipc: IPC_STUB, ...stubs };
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.endsWith(".css")) return { url: EMPTY, shortCircuit: true };
      if (/\.(png|svg|jpg|webp|woff2?)(\?.*)?$/.test(specifier)) {
        return { url: `data:text/javascript,export default ${encodeURIComponent(JSON.stringify(specifier))};`, shortCircuit: true };
      }
      if (specifier.startsWith(".") && context.parentURL?.startsWith(SRC)) {
        const url = new URL(specifier, context.parentURL);
        const key = url.href.slice(SRC.length).replace(/\.ts$/, "");
        if (url.href.startsWith(SRC) && Object.hasOwn(STUBS, key)) {
          return { url: `data:text/javascript,${encodeURIComponent(STUBS[key])}`, shortCircuit: true };
        }
        if (!/\.[a-z]+$/i.test(url.pathname)) {
          if (existsSync(fileURLToPath(`${url.href}.ts`))) return next(`${url.href}.ts`, context);
          if (existsSync(fileURLToPath(`${url.href}/index.ts`))) return next(`${url.href}/index.ts`, context);
        }
      }
      return next(specifier, context);
    },
  });

  // jsdom's selector engine (@asamuzakjp/dom-selector) adds 9 window listeners on its first
  // query; run one before the ledger starts so they are not charged to the code under test.
  window.document.querySelector(":focus");
  return {
    window,
    ipc,
    ledger: ledgerFor([window, window.document]),
    observers,
    /** let queued microtasks and zero-delay timers run */
    flush: () => new Promise((r) => setTimeout(r, 0)),
  };
}
