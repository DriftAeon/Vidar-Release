import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

// W3C of the module-rename run: user names reach the bench tab text, title and aria-label, never as markup.
const NAME = '<img src=x>"x';
const state = { names: { doc: NAME }, listeners: new Set() };
globalThis.__benchNames = state;

function view(id, mount, prefix) {
  return `export function ${mount}(root) {
    const el = document.createElement('div'); el.id = '${id}-view'; el.style.display = 'none';
    root.appendChild(el); return el;
  }
  export function ${prefix}Shown() {}
  export function ${prefix}Hidden() {}`;
}

const dom = setupDom({ stubs: {
  prefs: 'export const getPref = () => undefined; export const setPref = () => true;',
  ipc: 'export function getCurrentWebview() { return { onDragDropEvent() { return Promise.resolve(() => {}); } }; }',
  'modules/registry': 'export const moduleListed = () => true; export const onModulesChange = () => () => {};',
  'modules/names': `const s = globalThis.__benchNames;
    export const moduleName = (id, builtin) => s.names[id] || builtin;
    export const onModuleNamesChange = (cb) => { s.listeners.add(cb); return () => s.listeners.delete(cb); };`,
  'panels/sessions': 'export function openWorkbench() {} export function isWorkbenchOpen() { return true; }',
  'panels/sessions/zoom': 'export function showSessionsToast() {}',
  'panels/document': view('doc', 'mountDocumentView', 'onDocument') + 'export async function openDocumentPath() { return true; }',
  'panels/flow': view('flow', 'mountFlowView', 'onFlow'),
  'panels/runes': view('runelib', 'mountRunesView', 'onRunes') + 'export function disposeRunesView() {}',
  'panels/lab': view('lab', 'mountLabView', 'onLab') + 'export function disposeLabView() {}',
  'panels/relay': view('relay', 'mountRelayTab', 'onRelay'),
  'panels/workbench-tab-icons': 'export function tabIcon() { return document.createElement("img"); }',
  'panels/reorder': 'export function applyOrder() {} export function enableReorder() {}',
  'panels/workbench-tray': 'export function mountTray() {} export function onPaste() {} export function dropPaths() {}',
} });
globalThis.CustomEvent = dom.window.CustomEvent;

const bench = await import('../src/panels/workbench.ts');
bench.mountWorkbench(document.body, { open() {}, collapse() {} });
bench.setWorkbenchShown(true);
const root = document.querySelector('#workbench');
const tab = id => root.querySelector(`.wb-tab[data-tab="${id}"]`);

test('a user name lands as text, title and aria-label, never markup', () => {
  const doc = tab('doc');
  assert.equal(doc.querySelector('span').textContent, NAME);
  assert.equal(doc.title, NAME);
  assert.equal(doc.getAttribute('aria-label'), NAME);
  assert.equal(root.querySelector('#wb-tabs img[src="x"]'), null, 'no injected element');
  assert.equal(doc.querySelectorAll('img').length, 1, 'only the tab icon');
  assert.equal(tab('flow').querySelector('span').textContent, 'Flow');
});

test('icon-only tabs carry the name in title and aria-label only', () => {
  state.names = { tray: 'Stash' };
  state.listeners.forEach(cb => cb());
  assert.equal(tab('tray').querySelector('span'), null);
  assert.equal(tab('tray').title, 'Stash');
  assert.equal(tab('tray').getAttribute('aria-label'), 'Stash');
});

test('a names change relabels without losing the icon or the current mark', () => {
  state.names = { doc: 'Docs', runelib: 'Rules' };
  state.listeners.forEach(cb => cb());
  const doc = tab('doc');
  assert.equal(doc.querySelector('span').textContent, 'Docs');
  assert.equal(doc.title, 'Docs');
  assert.equal(doc.getAttribute('aria-label'), 'Docs');
  assert.ok(doc.querySelector('img'), 'icon kept');
  assert.equal(tab('runelib').querySelector('span').textContent, 'Rules');
  assert.equal(tab('tray').title, 'Tray', 'a cleared name returns to the built-in');
  assert.equal(root.querySelector('.wb-tab[aria-current="true"]').dataset.tab, 'tray');
});

test('the tab menu uses the current name', () => {
  tab('doc').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
  const items = [...document.querySelectorAll('[role="menuitem"]')].map(i => i.textContent);
  assert.ok(items.includes('Hide Docs'), items.join('|'));
});
