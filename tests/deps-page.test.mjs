// The Dependencies page tab: mountDependencies paints a root before it is attached
// (a connected-only paint left an empty page), and repaints it on a
// deps change until its dispose runs.
//
// dependencies.ts has bundler-style extensionless imports and pulls the modal, IPC and the sessions
// world, so a resolve hook maps extensionless src imports to their .ts file and swaps the side-effect
// modules for stubs. Real: deps/state (the report cache), settings/registry, dependencies-view.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
});

const catalog = JSON.parse(readFileSync(new URL("../contracts/dependencies.json", import.meta.url), "utf8"));

// What detect_dependencies returns; each test sets it before loadDeps().
const stub = { report: null };
globalThis.__depsPageStub = stub;

const SRC = new URL("../src/", import.meta.url).href;
const STUBS = {
  ipc: `export function invoke(cmd) {
    if (cmd === "detect_dependencies") return Promise.resolve(globalThis.__depsPageStub.report);
    return Promise.reject(new Error("unstubbed invoke: " + cmd));
  }
  export function listen() { return Promise.resolve(() => {}); }`,
  clipboard: "export async function copyText() { return true; }",
  prefs: "const m = new Map(); export function getPref(k) { return m.get(k); } export function setPref(k, v) { m.set(k, v); }",
  "settings/modal": "export function openShortcutsModal() {} export function closeShortcutsModal() {}",
  "deps/setup-agent": "export function setupAgentBlocker() { return null; } export async function startSetupAgent() { return ''; }",
  "styles/voice-slots.css": "",
};

registerHooks({
  resolve(specifier, context, next) {
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

const page = await import("../src/settings/dependencies.ts");
const state = await import("../src/deps/state.ts");

const missingIds = (root) => [...root.querySelectorAll(".deps-row.is-missing")].map((r) => r.dataset.id);

test("mountDependencies paints a detached root", () => {
  const root = document.createElement("div");
  const dispose = page.mountDependencies(root);
  assert.equal(root.isConnected, false);
  const ids = [...root.querySelectorAll(".deps-row[data-id]")].map((r) => r.dataset.id);
  assert.deepEqual(ids, catalog.deps.map((d) => d.id));
  dispose();
});

test("a deps change repaints every mounted root until its dispose runs", async () => {
  const a = document.createElement("div");
  const b = document.createElement("div");
  const disposeA = page.mountDependencies(a);
  const disposeB = page.mountDependencies(b);
  assert.deepEqual(missingIds(a), []);

  const dep = catalog.deps.find((d) => d.required);
  assert.ok(dep, "catalog has no required entry");
  stub.report = { root: "C:\\Vidar", deps: catalog.deps.map((d) => ({ id: d.id, found: d.id !== dep.id })) };
  assert.ok(await state.loadDeps(), "loadDeps resolved null against the stub report");
  assert.deepEqual(missingIds(a), [dep.id]);
  assert.deepEqual(missingIds(b), [dep.id]);

  // dispose detaches the page from `a`, so a leaked repaint would only show in the page itself
  const pa = a.firstElementChild;
  assert.ok(pa, "no page element in the mounted root");
  disposeA();
  assert.equal(a.querySelector(".deps-row"), null, "dispose leaves the page in the root");
  stub.report = { root: "C:\\Vidar", deps: catalog.deps.map((d) => ({ id: d.id, found: true })) };
  assert.ok(await state.loadDeps());
  assert.equal(a.querySelector(".deps-row"), null, "a disposed root was repainted");
  assert.deepEqual(missingIds(pa), [dep.id], "a disposed page was repainted");
  assert.deepEqual(missingIds(b), []);
  disposeB();
});
