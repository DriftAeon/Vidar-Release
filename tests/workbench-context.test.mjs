import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

const state = { saved: [], mounts: {}, menu: null, changeEvents: 0, reorder: null };
globalThis.__workbenchContext = state;

function view(id, mount, prefix) {
  return `export function ${mount}(root) {
    const s = globalThis.__workbenchContext;
    s.mounts['${id}'] = (s.mounts['${id}'] || 0) + 1;
    const el = document.createElement('div'); el.id = '${id}-view'; el.style.display = 'none';
    root.appendChild(el); return el;
  }
  export function ${prefix}Shown() {}
  export function ${prefix}Hidden() {}`;
}

const dom = setupDom({ stubs: {
  prefs: `export function getPref(key) {
      const s = globalThis.__workbenchContext;
      return key === 'modules.hidden' ? s.saved : undefined;
    }
    export function setPref(key, value) {
      const s = globalThis.__workbenchContext;
      if (key === 'modules.hidden') s.saved = value;
      return true;
    }`,
  ipc: 'export function getCurrentWebview() { return { onDragDropEvent() { return Promise.resolve(() => {}); } }; }',
  'modules/registry': 'export const moduleListed = () => true; export const onModulesChange = () => () => {};',
  'panels/sessions': 'export function openWorkbench() {} export function isWorkbenchOpen() { return true; }',
  'panels/sessions/zoom': 'export function showSessionsToast() {}',
  'panels/document': view('doc', 'mountDocumentView', 'onDocument') + 'export async function openDocumentPath() { return true; }',
  'panels/flow': view('flow', 'mountFlowView', 'onFlow'),
  'panels/runes': view('runelib', 'mountRunesView', 'onRunes') + 'export function disposeRunesView() {}',
  'panels/lab': view('lab', 'mountLabView', 'onLab') + 'export function disposeLabView() {}',
  'panels/relay': view('relay', 'mountRelayTab', 'onRelay'),
  'panels/workbench-tab-icons': 'export function tabIcon() { return document.createElement("img"); }',
  'panels/reorder': `export function applyOrder() {}
    export function enableReorder(track, key, options) {
      globalThis.__workbenchContext.reorder = { track, key, options };
    }`,
  'modules/names': 'export const moduleName = (id, builtin) => builtin; export const onModuleNamesChange = () => () => {};',
  'panels/workbench-tray': `export const TRAY_LANDED_NOTE = 'Added to Tray';
    export function mountTray() {}
    export function onPaste() {} export function dropPaths() {}`,
} });
globalThis.CustomEvent = dom.window.CustomEvent;

document.addEventListener('vidar-modules-change', () => state.changeEvents++);
const bench = await import('../src/panels/workbench.ts');
bench.mountWorkbench(document.body, { open() {}, collapse() {} });
bench.setWorkbenchShown(true);
const root = document.querySelector('#workbench');
const head = root.querySelector('#workbench-head');
const track = root.querySelector('#wb-tabs');
const tab = id => root.querySelector(`.wb-tab[data-tab="${id}"]`);
const openMenu = (anchor, key = 'ContextMenu') => {
  anchor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, shiftKey: key === 'F10', bubbles: true, cancelable: true }));
  return document.querySelector('[role="menu"]');
};
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')];
const openContext = anchor => {
  anchor.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 15 }));
  return document.querySelector('[role="menu"]');
};

test('visible required and optional tabs offer Hide; Relay remains fixed', () => {
  for (const [id, label] of [['tray', 'Tray'], ['doc', 'Document'],
    ['flow', 'Flow'], ['runelib', 'Runes'], ['lab', 'Lab']]) {
    assert.ok(openContext(tab(id)), `${id} opens the shared menu`);
    assert.ok(menuItems().some(item => item.textContent === `Hide ${label}`), `${id} offers its own Hide`);
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }
  openContext(tab('tray'));
  menuItems().find(item => item.textContent === 'Hide Tray').click();
  assert.ok(state.saved.includes('bench:tray'));
  assert.equal(tab('tray').style.display, 'none');
  assert.equal(root.querySelector('.wb-tab[aria-current="true"]').dataset.tab, 'relay');
  openContext(tab('runelib'));
  menuItems().find(item => item.textContent === 'Hide Runes').click();
  assert.ok(state.saved.includes('bench:runelib'));
  assert.equal(tab('runelib').style.display, 'none');
  assert.equal(root.querySelector('#runelib-view'), null, 'optional view is disposed');
  openContext(tab('relay'));
  assert.equal(menuItems().some(item => item.textContent.startsWith('Hide ')), false, 'Relay has no Hide action');
  assert.ok(menuItems().some(item => item.textContent === 'Modules…'), 'mock management shortcut remains available');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

test('head menu offers Show for saved-hidden tabs and changes saved visibility', () => {
  state.saved = ['bench:runelib', 'bench:doc'];
  bench.syncWorkbenchTabVisibility();
  assert.equal(tab('runelib').style.display, 'none');
  openContext(head);
  const showDoc = menuItems().find(item => item.textContent === 'Show Document');
  const showRunes = menuItems().find(item => item.textContent === 'Show Runes');
  assert.ok(showDoc);
  assert.ok(showRunes);
  const before = state.changeEvents;
  showDoc.click();
  assert.equal(tab('doc').style.display, '');
  assert.equal(state.saved.includes('bench:doc'), false);
  assert.equal(state.changeEvents, before + 1);
});

test('temporary reveal retains saved hidden state and its tab menu offers Show', () => {
  state.saved = ['bench:doc'];
  bench.syncWorkbenchTabVisibility();
  assert.equal(bench.revealWorkbenchTab('doc'), true);
  assert.equal(tab('doc').style.display, '');
  assert.ok(state.saved.includes('bench:doc'));
  openContext(tab('doc'));
  assert.ok(menuItems().some(item => item.textContent === 'Show Document'));
  const show = menuItems().find(item => item.textContent === 'Show Document');
  show.click();
  assert.equal(state.saved.includes('bench:doc'), false);
  assert.equal(tab('doc').style.display, '');
});

test('row keyboard invocation works and existing horizontal tab dragging stays wired', () => {
  state.saved = ['bench:runelib'];
  bench.syncWorkbenchTabVisibility();
  assert.equal(head.tabIndex, 0, 'row is keyboard reachable');
  assert.ok(openMenu(head, 'F10'), 'Shift+F10 opens the row menu');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.ok(openMenu(tab('relay')), 'ContextMenu key opens from a tab');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(state.reorder?.track, track);
  assert.equal(state.reorder?.key, 'order.workbenchTabs');
  assert.equal(state.reorder?.options?.handle, '.wb-tab');
  assert.equal(state.reorder?.options?.axis, 'x');
});
