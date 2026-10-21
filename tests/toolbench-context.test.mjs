import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

const state = {
  prefs: new Map([['modules.hidden', []], ['order.tools', ['marquee', 'eyedropper']]]),
  calls: [], writes: [], activeSession: 'tab-a',
};
globalThis.__toolbenchContext = state;
const { window, flush } = setupDom({ stubs: {
  prefs: `export const getPref = key => globalThis.__toolbenchContext.prefs.get(key);
    export const setPref = (key, value) => {
      globalThis.__toolbenchContext.prefs.set(key, value); return true;
    };`,
  ipc: `export const invoke = command => {
      globalThis.__toolbenchContext.calls.push(command); return Promise.resolve('');
    };
    export const listen = () => Promise.resolve(() => {});`,
  'panels/inspect': 'export const exitInspect = () => {}; export const onInspectEnter = () => {};',
  'panels/sessions': `export const getActiveSessionId = () => globalThis.__toolbenchContext.activeSession;
    export const writeToActive = async text => {
      const s = globalThis.__toolbenchContext;
      s.writes.push({ session: s.activeSession, text }); return true;
    };
    export const focusActive = () => {};`,
  'panels/workbench': 'export const revealWorkbench = () => {};',
  'panels/workbench-tray': 'export const addTextBlock = () => ({ ok: true });',
  clipboard: 'export const copyText = async () => true;',
  'icon-img': 'export const iconImg = () => document.createElement("span");',
} });

const { createToolRegistry } = await import('../src/tools/registry.ts');
const { initToolbench } = await import('../src/panels/toolbench.ts');
const grid = document.createElement('div');
grid.id = 'tool-grid';
const options = document.createElement('div');
document.body.append(grid, options);
let changes = 0;
document.addEventListener('vidar-modules-change', () => changes++);
const mount = () => initToolbench(grid, options, createToolRegistry());
const button = id => grid.querySelector(`[data-key="${id}"]`);
const keys = () => [...grid.children].map(el => el.dataset.key);
const items = () => [...document.querySelectorAll('[role="menuitem"]')];
const context = target => target.dispatchEvent(new window.MouseEvent('contextmenu', {
  bubbles: true, cancelable: true, clientX: 12, clientY: 15,
}));
const keyboard = (target, key, shiftKey = false) => target.dispatchEvent(
  new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
const dismiss = () => keyboard(document, 'Escape');

test('tool Hide and blank-area Show save state and refresh the toolbar', async () => {
  await mount();
  await flush();
  assert.deepEqual(keys(), ['marquee', 'eyedropper']);
  context(button('marquee'));
  assert.ok(items().some(item => item.textContent === 'Hide Marquee Read Text'));
  items().find(item => item.textContent === 'Hide Marquee Read Text').click();
  assert.deepEqual(state.prefs.get('modules.hidden'), ['tool:marquee']);
  assert.deepEqual(keys(), ['eyedropper']);
  assert.equal(changes, 1);

  context(grid);
  assert.ok(items().some(item => item.textContent === 'Show Marquee Read Text'));
  items().find(item => item.textContent === 'Show Marquee Read Text').click();
  assert.deepEqual(state.prefs.get('modules.hidden'), []);
  assert.deepEqual(keys(), ['marquee', 'eyedropper']);
  assert.equal(changes, 2);
});

test('armed right-click cancels first; keyboard menu works on button and blank grid', () => {
  button('eyedropper').click();
  assert.ok(document.body.classList.contains('eyedrop-mode'));
  context(button('eyedropper'));
  assert.equal(document.body.classList.contains('eyedrop-mode'), false);
  assert.equal(document.querySelector('[role="menu"]'), null);

  button('marquee').click();
  assert.equal(state.calls.at(-1), 'ocr_begin');
  context(grid);
  assert.equal(state.calls.at(-1), 'ocr_cancel');
  assert.equal(document.querySelector('[role="menu"]'), null);

  button('eyedropper').focus();
  keyboard(button('eyedropper'), 'ContextMenu');
  assert.ok(items().some(item => item.textContent === 'Hide Eyedropper'));
  dismiss();
  assert.equal(document.activeElement, button('eyedropper'));
  keyboard(grid, 'F10', true);
  assert.ok(items().some(item => item.textContent === 'Modules…'));
  dismiss();
});

test('saved order and the marquee strip survive context visibility changes', async () => {
  state.prefs.set('order.tools', ['eyedropper', 'marquee']);
  document.dispatchEvent(new window.CustomEvent('vidar-modules-change'));
  assert.deepEqual(keys(), ['eyedropper', 'marquee']);
  context(button('eyedropper'));
  items().find(item => item.textContent === 'Hide Eyedropper').click();
  assert.deepEqual(keys(), ['marquee']);
  context(grid);
  items().find(item => item.textContent === 'Show Eyedropper').click();
  assert.deepEqual(keys(), ['eyedropper', 'marquee']);

  button('marquee').click();
  options.querySelector('#mq-text').value = 'Selected text';
  options.querySelector('#mq-text').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(options.querySelector('#mq-insert'), null);
  assert.equal(options.querySelector('#mq-copy').disabled, false);
});

test('a module name rewrites the menu and the aria-label head; a change re-syncs mounted buttons', async () => {
  const { setModuleNames } = await import('../src/modules/names.ts');
  const plain = button('marquee').getAttribute('aria-label');
  assert.ok(plain.startsWith('Marquee — '), plain);
  setModuleNames({ marquee: 'Snip' });
  assert.equal(button('marquee').getAttribute('aria-label'), plain.replace(/^[^—]*/, 'Snip '));
  if (button('marquee').classList.contains('active')) button('marquee').click();
  context(button('marquee'));
  assert.ok(items().some(item => item.textContent === 'Hide Snip'));
  dismiss();
  setModuleNames({});
  assert.equal(button('marquee').getAttribute('aria-label'), plain);
});