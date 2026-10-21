import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const state = { mounts: [], hooks: [], bodies: {}, loaded: [], hidden: ["bench:runelib", "bench:lab", "bench:changes", "bench:unreal", "bench:jira", "bench:notion", "bench:slack"], relayReady: false };
globalThis.__benchLifecycle = state;
const view = (id, mount, prefix, extra = "") => `
  export function ${mount}(root, ...args) {
    const s = globalThis.__benchLifecycle;
    s.mounts.push('${id}');
    s.originalBody ??= root.querySelector('#workbench-body');
    ${extra}
    const el = document.createElement('div');
    el.id = '${id}-view'; el.style.display = 'none';
    root.appendChild(el); s.bodies['${id}'] = el;
    return el;
  }
  export function ${prefix}Shown() { globalThis.__benchLifecycle.hooks.push('${id}:shown'); }
  export function ${prefix}Hidden() { globalThis.__benchLifecycle.hooks.push('${id}:hidden'); }
`;

const dom = setupDom({ stubs: {
  prefs: "export function getPref(key) { return key === 'modules.hidden' ? globalThis.__benchLifecycle.hidden : undefined; }",
  ipc:"export function getCurrentWebview() { return { onDragDropEvent() { return Promise.resolve(() => {}); } }; }",
  "modules/registry": "export const moduleListed = () => true; export const onModulesChange = () => () => {};",
  "panels/sessions": "export function openWorkbench() {} export function isWorkbenchOpen() { return true; }",
  "panels/sessions/zoom": "export function showSessionsToast() {}",
  "panels/document": view("doc", "mountDocumentView", "onDocument") + "export async function openDocumentPath() { return true; }",
  "panels/flow": view("flow", "mountFlowView", "onFlow"),
  "panels/runes": "globalThis.__benchLifecycle.loaded.push('runelib');" + view("runelib", "mountRunesView", "onRunes") + "export function disposeRunesView() {}",
  "panels/lab": "globalThis.__benchLifecycle.loaded.push('lab');" + view("lab", "mountLabView", "onLab") + "export function disposeLabView() {}",
  "panels/changes": "globalThis.__benchLifecycle.loaded.push('changes');" + view("changes", "mountChangesView", "onChanges") + "export function disposeChangesView() {}",
  "panels/unreal": "globalThis.__benchLifecycle.loaded.push('unreal');" + view("unreal", "mountUnrealView", "onUnreal") + "export function disposeUnrealView() {}",
  "panels/jira": "globalThis.__benchLifecycle.loaded.push('jira');" + view("jira", "mountJiraView", "onJira") + "export function disposeJiraView() {}",
  "panels/notion": "globalThis.__benchLifecycle.loaded.push('notion');" + view("notion", "mountNotionView", "onNotion") + "export function disposeNotionView() {}",
  "panels/slack": "globalThis.__benchLifecycle.loaded.push('slack');" + view("slack", "mountSlackView", "onSlack") + "export function disposeSlackView() {}",
  "panels/relay": view("relay", "mountRelayTab", "onRelay", `
    s.relayReady = [...root.querySelectorAll('.wb-tab')].every(b => b.firstElementChild?.matches('img.icn'));
    args[0](true);
    s.relayAlertDuringMount = root.querySelector('[data-tab="relay"] img.icn').getAttribute('src');
    args[0](false);
  `),
  "panels/workbench-tab-icons": `export function tabIcon(id) {
    const el = document.createElement('img'); el.className = 'icn';
    el.src = '/icons/color/' + id + '.svg'; return el;
  }`,
  "panels/reorder": "export function applyOrder() {} export function enableReorder() {}",
  "modules/names": "export const moduleName = (id, builtin) => builtin; export const onModuleNamesChange = () => () => {};",
  "panels/workbench-tray": `export const TRAY_LANDED_NOTE = 'Added to Tray';
    export function mountTray(body, callbacks) {
      const s = globalThis.__benchLifecycle; s.mounts.push('tray');
      s.trayBody = body; s.trayConnected = body.isConnected;
      s.trayActive = callbacks.trayActive;
    }
    export function onPaste() {} export function dropPaths() {}`,
} });

const bench = await import("../src/panels/workbench.ts");
bench.mountWorkbench(document.body, { open() {}, collapse() {} });
const root = document.querySelector("#workbench");
const ids = ["relay", "tray", "doc", "flow", "runelib", "lab", "changes", "unreal", "jira", "notion", "slack"];

test("optional chunks stay unloaded while off and a rapid on/off cannot mount stale views", async () => {
  await dom.flush();
  assert.deepEqual(state.loaded, [], "saved-off modules do not load their chunks");
  bench.setWorkbenchTabVisibility("runelib", true);
  bench.setWorkbenchTabVisibility("runelib", false);
  await dom.flush();
  assert.equal(state.mounts.includes("runelib"), false, "the canceled import did not mount");
  assert.equal(root.querySelector("#runelib-view"), null);

  bench.setWorkbenchTabVisibility("runelib", true);
  bench.setWorkbenchTabVisibility("lab", true);
  root.querySelector('[data-tab="lab"]').click();
  root.querySelector('[data-tab="doc"]').click();
  for (let i = 0; i < 10 && !state.mounts.includes("lab"); i++) await dom.flush();
  assert.equal(root.querySelector('[aria-current="true"]').dataset.tab, "doc", "a pending load cannot replace a newer selection");
  assert.equal(state.bodies.lab.style.display, "none");
  bench.setWorkbenchTabVisibility("changes", true);
  for (let i = 0; i < 10 && !state.mounts.includes("changes"); i++) await dom.flush();
  bench.setWorkbenchTabVisibility("unreal", true);
  for (let i = 0; i < 10 && !state.mounts.includes("unreal"); i++) await dom.flush();
  bench.setWorkbenchTabVisibility("jira", true);
  for (let i = 0; i < 10 && !state.mounts.includes("jira"); i++) await dom.flush();
  bench.setWorkbenchTabVisibility("notion", true);
  for (let i = 0; i < 10 && !state.mounts.includes("notion"); i++) await dom.flush();
  bench.setWorkbenchTabVisibility("slack", true);
  for (let i = 0; i < 10 && !state.mounts.includes("slack"); i++) await dom.flush();
  assert.deepEqual(state.loaded, ["runelib", "lab", "changes", "unreal", "jira", "notion", "slack"]);
  assert.equal(state.mounts.filter(id => id === "runelib").length, 1);
  assert.equal(state.mounts.filter(id => id === "lab").length, 1);
  root.querySelector('[data-tab="tray"]').click();
  state.hooks.length = 0;
});

test("bench registry preserves markup, initial selection, mount order and body identity", () => {
  const track = root.querySelector("#wb-tabs");
  assert.equal(track.firstElementChild.id, "wb-fill");
  const buttons = [...track.querySelectorAll(".wb-tab")];
  assert.deepEqual(buttons.map(b => b.dataset.tab), ids);
  assert.deepEqual(buttons.map(b => b.dataset.key), ids);
  const labels = ["Relay", "Tray", "Document", "Flow", "Runes", "Lab", "Changes", "Unreal", "Jira", "Notion", "Slack"];
  buttons.forEach((button, index) => {
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.getAttribute("aria-label"), labels[index]);
    assert.equal(button.title, labels[index]);
    assert.equal(button.firstElementChild.matches("img.icn"), true);
    assert.equal(button.getAttribute("aria-current"), ids[index] === "tray" ? "true" : null);
    if (ids[index] === "relay" || ids[index] === "tray") {
      assert.equal(button.children.length, 1, `${labels[index]} is icon-only`);
      assert.equal(button.textContent.trim(), "", `${labels[index]} shows no label text`);
      return;
    }
    assert.equal(button.lastElementChild.tagName, "SPAN");
    assert.equal(button.lastElementChild.textContent, labels[index]);
  });
  assert.deepEqual(state.mounts, ["doc", "flow", "relay", "tray", "runelib", "lab", "changes", "unreal", "jira", "notion", "slack"]);
  assert.equal(state.relayReady, true, "all icons exist before Relay can notify synchronously");
  assert.equal(state.relayAlertDuringMount, "/icons/color/relay-alert.svg");
  assert.equal(buttons[0].querySelector("img.icn").getAttribute("src"), "/icons/color/relay.svg");
  assert.equal(state.trayBody, state.originalBody);
  assert.equal(state.trayBody, root.querySelector("#workbench-body"));
  assert.equal(state.trayConnected, true, "Tray mounts after the pane is appended");
  assert.equal(state.trayActive(), true);
  assert.equal(root.style.display, "none");
  assert.deepEqual(state.hooks, []);
});

test("bench dispatches selection and pane visibility to the selected mounted view", () => {
  bench.setWorkbenchShown(true);
  assert.deepEqual(state.hooks, [], "Tray has no view visibility hook");
  let previous = null;
  for (const id of ids.filter(id => id !== "tray")) {
    state.hooks.length = 0;
    root.querySelector(`[data-tab="${id}"]`).click();
    assert.deepEqual(state.hooks, [...(previous ? [`${previous}:hidden`] : []), `${id}:shown`]);
    assert.equal(root.querySelector('[aria-current="true"]').dataset.tab, id);
    assert.equal(state.trayBody.style.display, "none");
    for (const [viewId, body] of Object.entries(state.bodies)) {
      assert.equal(body.style.display, viewId === id ? "flex" : "none");
    }
    state.hooks.length = 0;
    bench.revealWorkbenchTab(id);
    assert.deepEqual(state.hooks, [], "selecting the same tab does not dispatch again");
    bench.setWorkbenchShown(false);
    bench.setWorkbenchShown(true);
    assert.deepEqual(state.hooks, [`${id}:hidden`, `${id}:shown`]);
    state.hooks.length = 0;
    bench.setWorkbenchShown(true);
    assert.deepEqual(state.hooks, [], "showing an already shown pane does not fire onShown again");
    previous = id;
  }
  state.hooks.length = 0;
  bench.setWorkbenchShown(false);
  bench.revealWorkbenchTab("doc");
  assert.deepEqual(state.hooks, [`${previous}:hidden`], "selection while hidden does not show a view");
  bench.setWorkbenchShown(true);
  assert.deepEqual(state.hooks, [`${previous}:hidden`, "doc:shown"]);
  root.querySelector('[data-tab="tray"]').click();
  assert.equal(state.trayActive(), true);
  assert.equal(state.trayBody.style.display, "");
  assert.deepEqual(state.mounts, ["doc", "flow", "relay", "tray", "runelib", "lab", "changes", "unreal", "jira", "notion", "slack"], "switching retains mounted bodies");
});

test("a view mounted after the mini bar docked lands above it, so the bar stays the last child", async () => {
  const bar = document.createElement("div");
  bar.id = "bottombar";
  root.appendChild(bar); // sessions/bottombar-dock.ts docks it at the end of #workbench
  bench.setWorkbenchTabVisibility("jira", false);
  bench.setWorkbenchTabVisibility("jira", true);
  for (let i = 0; i < 10 && state.mounts.filter(id => id === "jira").length < 2; i++) await dom.flush();
  const jira = root.querySelector("#jira-view");
  assert.ok(jira, "Jira remounted");
  assert.equal(root.lastElementChild, bar, "the bar stays below every view");
  assert.equal(jira.nextElementSibling, bar);
  bar.remove();
});
