// Backend lookups must not return a tab that closed or changed attachments while IPC was pending;
// "does any tab host X" lookups check the tab record only, so a Claude sessionId arriving mid-lookup
// does not hide a spawned hosted tab. sessions.ts loads with the page-tab.test.mjs stubs so the
// removal order (map delete before dropTabState) is observable through a stubbed tab-state-feeds.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setupDom } from "./helpers/dom-mount.mjs";

const IPC = `export function invoke(cmd, args) {
    const h = globalThis.__domMount; h.invoked.push(cmd);
    if (Object.hasOwn(h.answers, cmd)) { const a = h.answers[cmd]; return Promise.resolve(typeof a === "function" ? a(args) : a); }
    return Promise.resolve(null);
  }
  export function listen() { return Promise.resolve(() => {}); }`;
const dom = setupDom({ stubs: {
  ipc: IPC,
  theme: "export function xtermTheme() { return {}; }",
  "panels/workbench": "export function mountWorkbench() {} export function setWorkbenchShown() {} export function revealWorkbenchTab() {}",
  "panels/split": "export function initSplit() {}",
  "panels/rendered": "export function createFalconAdoptTransport() {} export function createRenderedBody() {} export function falconAgentTransport() {}",
  "character/events": "export function dispatchCharacterActivity() {} export function dispatchCharacterCompletion() {} export function dispatchCharacterStatus() {}",
  "panels/reply-events": "export function dispatchReplyDone() {}",
  "panels/sessions/astra-bridge": `export const armedId = null; export function armAstra() {} export function bindAstraBridge() {}
    export function disarmAstra() {} export async function initAstraBridge() {} export function armBlocker() { return null; }
    export function hasArmedAstra() { return false; } export function isArmed() { return false; }`,
  "panels/sessions/tab-strip": `let deps; let strip;
    export function bindTabStrip(d) { deps = d; globalThis.__tabStripDeps = d; }
    export function initTabStrip(s) { strip = s; }
    export function buildTabButton(id, opts) { const b = document.createElement("button"); b.dataset.id = id; b.title = opts?.title ?? id; strip.appendChild(b); return b; }
    export function resolveBodyKind() { return { kind: "shell", body: "terminal" }; }
    export function orderedIds() { return [...deps.sessions.keys()]; }
    export function dismissTabMenuFor() {} export function openTabMenu() {}`,
  "panels/sessions/zoom": "export const currentFont = 14; export function bindZoom() {} export function initZoom() {} export function showSessionsToast() {} export function zoomBy() {} export function zoomReset() {}",
  "panels/sessions/search-overlay": "export function bindSearchOverlay() {} export function buildSearchOverlay() {} export function openSearch() {}",
  "panels/sessions/tab-state-feeds": `export function dropTabState(id) { globalThis.__onDropTabState?.(id); }
    export function feedRaw() {} export function feedRendered() {} export function feedDetached() {} export function initTabState() {}`,
} });
const BARE = ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-unicode11", "@xterm/addon-search", "@xterm/addon-web-links"];
const bareStub = "export class Terminal {} export class FitAddon {} export class Unicode11Addon {} export class SearchAddon {} export class WebLinksAddon {}";
registerHooks({
  resolve(specifier, context, next) {
    if (BARE.includes(specifier)) return { url: `data:text/javascript,${encodeURIComponent(bareStub)}`, shortCircuit: true };
    return next(specifier, context);
  },
});

// node's own Event/CustomEvent globals win in setupDom; jsdom's dispatchEvent needs jsdom's
Object.assign(globalThis, { Event: dom.window.Event, CustomEvent: dom.window.CustomEvent });

const sessionsMod = await import("../src/panels/sessions.ts");
const view = document.createElement("div");
const strip = document.createElement("div");
document.body.append(view, strip);
await sessionsMod.initSessions(view, strip, () => {});

const lookup = await import("../src/panels/sessions/lookup.ts");
const tabs = new Map();
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const tab = () => ({ rendered: { hosted: () => true, sessionId: () => "claude-1" } });

beforeEach(() => {
  tabs.clear();
  dom.ipc.answers = {};
  lookup.bindLookup({ sessions: tabs, getActiveId: () => null });
});

test("late hosted lookup after close returns no tab or Falcon identity", async () => {
  tabs.set("closed", tab());
  const pending = deferred();
  dom.ipc.answers.falcon_hosted_session = () => pending.promise;
  const id = lookup.findTabByFalconSessionHosted("falcon-1");
  const identity = lookup.hostedFalconSession("closed");
  const open = lookup.openFalconSessionIds();
  tabs.delete("closed");
  pending.resolve("falcon-1");
  assert.equal(await id, null);
  assert.equal(await identity, null);
  assert.deepEqual(await open, []);
});

test("lookup rejects a changed tab record or attachment while IPC is pending", async () => {
  for (const mutate of [
    (s) => { s.falconSession = "adopted-new"; },
    (s) => { s.rendered = tab().rendered; },
    () => { tabs.set("changing", tab()); },
  ]) {
    tabs.clear();
    const s = tab();
    tabs.set("changing", s);
    const pending = deferred();
    dom.ipc.answers.falcon_hosted_session = () => pending.promise;
    const result = lookup.findTabByFalconSessionHosted("falcon-old");
    mutate(s);
    pending.resolve("falcon-old");
    assert.equal(await result, null);
  }
});

test("a spawned hosted tab whose sessionId arrives mid-lookup is still found; the full guard drops it", async () => {
  const s = tab();
  tabs.set("spawned", s);
  const pending = deferred();
  dom.ipc.answers.falcon_hosted_session = () => pending.promise;
  const id = lookup.findTabByFalconSessionHosted("falcon-1");
  const open = lookup.openFalconSessionIds();
  const full = lookup.resolveFalconTab("falcon-1");
  s.rendered.sessionId = () => "claude-new";
  pending.resolve("falcon-1");
  assert.equal(await id, "spawned");
  assert.deepEqual(await open, ["falcon-1"]);
  assert.equal(await full, null);
});

test("pairs recheck completed lookups after another tab delays the aggregate", async () => {
  const first = tab();
  first.falconSession = "adopted-old";
  tabs.set("adopted", first);
  tabs.set("slow", tab());
  const pending = deferred();
  dom.ipc.answers.falcon_hosted_session = () => pending.promise;
  const result = lookup.openFalconSessionIds();
  first.falconSession = "adopted-new";
  pending.resolve("falcon-slow");
  assert.deepEqual(await result, ["falcon-slow"]);
});

test("direct adopted lookup rechecks identity after its await", async () => {
  tabs.set("adopted", { falconSession: "falcon-1" });
  const result = lookup.findTabByFalconSessionHosted("falcon-1");
  tabs.delete("adopted");
  assert.equal(await result, null);
});

test("removeSessionView deletes the tab from the map before dropTabState runs", async () => {
  const live = globalThis.__tabStripDeps.sessions;
  const seen = [];
  globalThis.__onDropTabState = (id) => seen.push([id, live.has(id)]);
  try {
    const id = await sessionsMod.openPageTab({ id: "drop-order", title: "Drop Order", mount: () => () => {} });
    assert.equal(live.has(id), true);
    sessionsMod.closeSession(id);
    assert.deepEqual(seen, [[id, false]]);
  } finally {
    globalThis.__onDropTabState = undefined;
  }
});
