// Page tabs (openPageTab, sessions.ts): one tab per page id, close runs the mount's dispose and
// never kill_pty, writes are refused without reaching write_pty, and focusing one dispatches
// vidar-focus with a null detail. sessions.ts loads under node through a resolve hook that maps
// extensionless src imports to .ts and swaps xterm, CSS, IPC and the sibling panel modules for
// stubs. The sessions/ modules astra-bridge, tab-strip, zoom and search-overlay are stubbed too;
// sessions.ts itself and the rest of sessions/ (types, output, terminal-body, rendered-body,
// lookup, hosted, message-open, file-links) stay real.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  CustomEvent: window.CustomEvent,
  MouseEvent: window.MouseEvent,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: (h) => clearTimeout(h),
});

const calls = [];
globalThis.__pageTabCalls = calls;

const SRC = new URL("../src/", import.meta.url).href;
const noop = "export {};";
const STUBS = {
  ipc: `export function invoke(cmd, args) { globalThis.__pageTabCalls.push(cmd); return Promise.resolve(null); }
    export function listen() { return Promise.resolve(() => {}); }`,
  theme: "export function xtermTheme() { return {}; }",
  "panels/workbench": "export function mountWorkbench() {} export function setWorkbenchShown() {} export function revealWorkbenchTab() {}",
  "panels/split": "export function initSplit() {}",
  "panels/rendered": "export function createFalconAdoptTransport() {} export function createRenderedBody() {} export function falconAgentTransport() {}",
  "character/events": "export function dispatchCharacterActivity() {} export function dispatchCharacterCompletion() {} export function dispatchCharacterStatus() {}",
  "panels/reply-events": "export function dispatchReplyDone() {}",
  "panels/sessions/astra-bridge": `export const armedId = null; export function armAstra() {} export function bindAstraBridge() {}
    export function disarmAstra() {} export async function initAstraBridge() {}
    export function hasArmedAstra() { return false; }`,
  "panels/sessions/tab-strip": `let deps; let strip;
    export function bindTabStrip(d) { deps = d; }
    export function initTabStrip(s) { strip = s; }
    export function buildTabButton(id, opts) { const b = document.createElement("button"); b.dataset.id = id; b.title = opts?.title ?? id; strip.appendChild(b); return b; }
    export function resolveBodyKind() { return { kind: "shell", body: "terminal" }; }
    export function orderedIds() { return [...deps.sessions.keys()]; }
    export function dismissTabMenuFor() {} export function openTabMenu() {}`,
  "panels/sessions/zoom": "export const currentFont = 14; export function bindZoom() {} export function initZoom() {} export function showSessionsToast() {} export function zoomBy() {} export function zoomReset() {}",
  "panels/sessions/search-overlay": "export function bindSearchOverlay() {} export function buildSearchOverlay() {} export function openSearch() {}",
};
const BARE = ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-unicode11", "@xterm/addon-search", "@xterm/addon-web-links"];
const bareStub = "export class Terminal {} export class FitAddon {} export class Unicode11Addon {} export class SearchAddon {} export class WebLinksAddon {}";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) return { url: `data:text/javascript,${encodeURIComponent(noop)}`, shortCircuit: true };
    if (BARE.includes(specifier)) return { url: `data:text/javascript,${encodeURIComponent(bareStub)}`, shortCircuit: true };
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

const sessions = await import("../src/panels/sessions.ts");

const view = document.createElement("div");
const strip = document.createElement("div");
document.body.append(view, strip);
await sessions.initSessions(view, strip, () => {});

test("page tab: one id per page, null focus, refused writes, close disposes without kill_pty", async () => {
  const focus = [];
  document.addEventListener("vidar-focus", (e) => focus.push(e.detail));
  let mounts = 0;
  let disposes = 0;
  const spec = {
    id: "test-page",
    title: "Test Page",
    mount(root) {
      mounts++;
      root.appendChild(document.createElement("p"));
      return () => { disposes++; };
    },
  };

  const id = await sessions.openPageTab(spec);
  const again = await sessions.openPageTab(spec);
  assert.equal(again, id, "opening the same page twice made a second tab");
  assert.equal(mounts, 1);
  assert.ok(focus.length > 0, "no vidar-focus for the page tab");
  assert.equal(focus.at(-1), null, "page tab presented as a shell tab");

  assert.equal(await sessions.writeToSession(id, "x"), false);
  assert.equal(calls.includes("write_pty"), false, "write reached write_pty");

  sessions.closeSession(id);
  assert.equal(disposes, 1, "close did not run the mount's dispose");
  assert.equal(calls.includes("kill_pty"), false, "closing a page tab called kill_pty");
  assert.equal(sessions.isPageTab(id), false, "tab still registered after close");
});
