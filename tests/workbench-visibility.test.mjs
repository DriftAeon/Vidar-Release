import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

const state = {
  saved: ['bench:tray'], mounts: {}, disposals: {}, hooks: [], opened: [],
  pendingLab: null, labGeneration: 0,
  // modules/registry stub: ids a release set does not list, and onModulesChange subscribers.
  unlisted: new Set(), registrySubs: new Set(),
};
globalThis.__workbenchVisibility = state;

function view(id, mount, prefix, extra = '') {
  return `export function ${mount}(root, ...args) {
    const s = globalThis.__workbenchVisibility;
    s.mounts['${id}'] = (s.mounts['${id}'] || 0) + 1;
    ${extra}
    const el = document.createElement('div');
    el.id = '${id}-view'; el.style.display = 'none';
    root.appendChild(el);
    return el;
  }
  export function ${prefix}Shown() { globalThis.__workbenchVisibility.hooks.push('${id}:shown'); }
  export function ${prefix}Hidden() { globalThis.__workbenchVisibility.hooks.push('${id}:hidden'); }`;
}

const dom = setupDom({ stubs: {
  prefs: `export function getPref(key) {
    return key === 'modules.hidden' ? globalThis.__workbenchVisibility.saved : undefined;
  }`,
  ipc: 'export function getCurrentWebview() { return { onDragDropEvent() { return Promise.resolve(() => {}); } }; }',
  'modules/registry': `export const moduleListed = (id) => !globalThis.__workbenchVisibility.unlisted.has(id);
    export const onModulesChange = (fn) => {
      const subs = globalThis.__workbenchVisibility.registrySubs;
      subs.add(fn); return () => subs.delete(fn);
    };`,
  'panels/sessions': 'export function openWorkbench() {} export function isWorkbenchOpen() { return true; }',
  'panels/sessions/zoom': 'export function showSessionsToast() {}',
  'panels/document': view('doc', 'mountDocumentView', 'onDocument', 's.fixture = args[1];') + `
    export async function openDocumentPath(path) {
      globalThis.__workbenchVisibility.opened.push(path); return true;
    }`,
  'panels/flow': view('flow', 'mountFlowView', 'onFlow'),
  'panels/runes': view('runelib', 'mountRunesView', 'onRunes', `
    s.runesFocus = () => { s.runesFocusCalls = (s.runesFocusCalls || 0) + 1; };
    document.addEventListener('vidar-focus', s.runesFocus);
  `) + `
    export function disposeRunesView() {
      const s = globalThis.__workbenchVisibility;
      s.disposals.runelib = (s.disposals.runelib || 0) + 1;
      document.removeEventListener('vidar-focus', s.runesFocus);
      s.runesFocus = null;
    }`,
  'panels/lab': view('lab', 'mountLabView', 'onLab') + `
    export function disposeLabView() {
      const s = globalThis.__workbenchVisibility;
      s.disposals.lab = (s.disposals.lab || 0) + 1;
      s.labGeneration++;
      s.pendingLab = null;
    }`,
  'panels/relay': view('relay', 'mountRelayTab', 'onRelay'),
  'panels/workbench-tab-icons': `export function tabIcon() {
    const el = document.createElement('img'); el.className = 'icn'; return el;
  }`,
  'panels/reorder': 'export function applyOrder() {} export function enableReorder() {}',
  'modules/names': 'export const moduleName = (id, builtin) => builtin; export const onModuleNamesChange = () => () => {};',
  'panels/workbench-tray': `export const TRAY_LANDED_NOTE = 'Added to Tray';
    export function mountTray(body, callbacks) {
      const s = globalThis.__workbenchVisibility;
      s.mounts.tray = (s.mounts.tray || 0) + 1;
      s.trayBody = body; s.navigate = callbacks.openInDocument;
    }
    export function onPaste() {} export function dropPaths() {}`,
} });

const bench = await import('../src/panels/workbench.ts');
bench.mountWorkbench(document.body, { open() {}, collapse() {} });
const root = document.querySelector('#workbench');
const selected = () => root.querySelector('.wb-tab[aria-current="true"]')?.dataset.tab;
const control = id => root.querySelector(`.wb-tab[data-tab="${id}"]`);
const body = id => root.querySelector(`#${id}-view`);
const initial = {
  selected: selected(),
  trayDisplay: control('tray').style.display,
  trayMounts: state.mounts.tray,
  trayConnected: state.trayBody?.isConnected,
};
bench.setWorkbenchShown(true);

test('required services stay mounted when saved-hidden, and hiding an active tab falls back to Relay', () => {
  const required = ['tray', 'doc', 'flow'];
  for (const id of required) assert.equal(state.mounts[id], 1, `${id} mounted`);
  state.saved = required.map(id => `bench:${id}`);
  bench.syncWorkbenchTabVisibility();
  for (const id of required) {
    assert.equal(control(id)?.style.display, 'none', `${id} control is hidden`);
    if (id !== 'tray') assert.equal(body(id)?.isConnected, true, `${id} service remains mounted`);
    assert.equal(state.mounts[id], 1, `${id} was not remounted`);
  }
  assert.equal(selected(), 'relay', 'the active Tray falls back');
  assert.notEqual(control('relay').style.display, 'none');
  assert.equal(state.mounts.relay, 1);
  assert.equal(bench.setWorkbenchTabVisibility('relay', false), false, 'core Relay cannot hide');
  assert.notEqual(control('relay').style.display, 'none');
  assert.equal(selected(), 'relay');
});

test('Document navigation temporarily reveals a saved-hidden required tab, then re-hides it', async () => {
  assert.equal(control('doc').style.display, 'none');
  await state.navigate('C:/fixture/note.md');
  assert.deepEqual(state.opened, ['C:/fixture/note.md']);
  assert.equal(selected(), 'doc');
  assert.notEqual(control('doc').style.display, 'none');
  assert.equal(body('doc').isConnected, true);
  assert.equal(state.mounts.doc, 1);
  assert.ok(state.saved.includes('bench:doc'), 'temporary reveal never saves a visibility change');
  assert.equal(bench.revealWorkbenchTab('relay'), true);
  assert.equal(control('doc').style.display, 'none');
  assert.ok(state.saved.includes('bench:doc'));
});

test('Document fixture callback and control selection use the same temporary reveal rule', () => {
  assert.equal(control('doc').style.display, 'none');
  state.fixture();
  assert.equal(selected(), 'doc');
  assert.notEqual(control('doc').style.display, 'none');
  assert.ok(state.saved.includes('bench:doc'));
  bench.revealWorkbenchTab('relay');
  assert.equal(control('doc').style.display, 'none');
  assert.equal(bench.revealWorkbenchTab('flow'), true, 'ctl.show selects hidden required Flow');
  assert.equal(selected(), 'flow');
  assert.notEqual(control('flow').style.display, 'none');
  assert.ok(state.saved.includes('bench:flow'));
  bench.revealWorkbenchTab('relay');
  assert.equal(control('flow').style.display, 'none');
  assert.equal(bench.revealWorkbenchTab('doc'), true, 'ctl.show selects hidden Document');
  assert.notEqual(control('doc').style.display, 'none');
  bench.revealWorkbenchTab('relay');
  assert.equal(control('doc').style.display, 'none');
});

test('optional-off refuses selection, retires listener and pending work, then remounts once', async () => {
  assert.equal(state.mounts.runelib, 1);
  assert.equal(state.mounts.lab, 1);
  assert.equal(bench.revealWorkbenchTab('runelib'), true);
  const priorFocus = state.runesFocusCalls || 0;
  document.dispatchEvent(new dom.window.Event('vidar-focus'));
  assert.equal(state.runesFocusCalls, priorFocus + 1);
  assert.equal(bench.setWorkbenchTabVisibility('runelib', false), true);
  assert.equal(selected(), 'relay', 'hiding active optional tab falls back');
  assert.equal(control('runelib').style.display, 'none');
  assert.equal(body('runelib'), null);
  document.dispatchEvent(new dom.window.Event('vidar-focus'));
  assert.equal(state.runesFocusCalls, priorFocus + 1, 'retired listener does not fire');
  assert.equal(state.disposals.runelib, 1);
  assert.equal(bench.revealWorkbenchTab('runelib'), false);
  assert.equal(selected(), 'relay');

  const pending = { generation: state.labGeneration };
  state.pendingLab = pending;
  assert.equal(bench.setWorkbenchTabVisibility('lab', false), true);
  assert.equal(state.disposals.lab, 1);
  assert.equal(state.pendingLab, null, 'pending result is invalidated');
  assert.equal(body('lab'), null);
  assert.equal(bench.revealWorkbenchTab('lab'), false);
  assert.equal(selected(), 'relay');

  assert.equal(bench.setWorkbenchTabVisibility('runelib', true), true);
  assert.equal(bench.setWorkbenchTabVisibility('lab', true), true);
  assert.equal(state.mounts.runelib, 2);
  assert.equal(state.mounts.lab, 2);
  assert.equal(bench.setWorkbenchTabVisibility('runelib', true), true);
  assert.equal(bench.setWorkbenchTabVisibility('lab', true), true);
  assert.equal(state.mounts.runelib, 2, 'repeated enable never double-mounts');
  assert.equal(state.mounts.lab, 2, 'repeated enable never double-mounts');
  assert.equal(body('runelib').isConnected, true);
  assert.equal(body('lab').isConnected, true);
  await dom.flush();
});

test('saved-hidden Tray selects Relay before the pane first opens while Tray stays mounted', () => {
  assert.deepEqual(initial, {
    selected: 'relay',
    trayDisplay: 'none',
    trayMounts: 1,
    trayConnected: true,
  });
});

const registryChanged = () => { for (const fn of [...state.registrySubs]) fn(); };

test('a release set that stops listing Lab drops its tab and view; listing it again remounts', () => {
  assert.equal(state.registrySubs.size, 1, 'the bench subscribes to registry changes');
  assert.equal(bench.revealWorkbenchTab('lab'), true);
  assert.equal(selected(), 'lab');
  const mounts = state.mounts.lab;
  const disposals = state.disposals.lab;
  state.unlisted = new Set(['lab']);
  registryChanged();
  assert.equal(selected(), 'relay', 'the active unlisted tab falls back like a hidden one');
  assert.equal(control('lab').style.display, 'none');
  assert.equal(body('lab'), null);
  assert.equal(state.disposals.lab, disposals + 1);
  assert.equal(bench.revealWorkbenchTab('lab'), false, 'an external open cannot select it');
  assert.equal(bench.setWorkbenchTabVisibility('lab', true), true);
  assert.equal(state.mounts.lab, mounts, 'a Show pref never mounts an unlisted tab');
  assert.equal(control('lab').style.display, 'none');
  assert.ok(!state.saved.includes('bench:lab'), 'unlisting writes no pref');
  state.unlisted = new Set();
  registryChanged();
  assert.equal(state.mounts.lab, mounts + 1);
  assert.notEqual(control('lab').style.display, 'none');
  assert.equal(body('lab').isConnected, true);
});

test('a bench mounted after a release list resolves never builds an unlisted tab', () => {
  state.unlisted = new Set(['lab', 'runelib']);
  const mounts = { lab: state.mounts.lab, runelib: state.mounts.runelib };
  bench.mountWorkbench(document.body, { open() {}, collapse() {} });
  assert.equal(state.registrySubs.size, 1, 'a remount replaces its registry subscription');
  const fresh = [...document.querySelectorAll('#workbench')].at(-1);
  for (const id of ['lab', 'runelib']) {
    assert.equal(fresh.querySelector(`.wb-tab[data-tab="${id}"]`).style.display, 'none', `${id} has no visible tab`);
    assert.equal(state.mounts[id], mounts[id], `${id} view never mounts`);
  }
  assert.notEqual(fresh.querySelector('.wb-tab[data-tab="relay"]').style.display, 'none');
  state.unlisted = new Set();
});

test('a saved Hide naming the retired Display tab paints nothing and the rest still hides', () => {
  state.saved = ['bench:display', 'bench:flow'];
  bench.mountWorkbench(document.body, { open() {}, collapse() {} });
  const fresh = [...document.querySelectorAll('#workbench')].at(-1);
  assert.equal(fresh.querySelector('.wb-tab[data-tab="display"]'), null, 'no Display tab');
  assert.equal(fresh.querySelector('.wb-tab[data-tab="flow"]').style.display, 'none');
});
