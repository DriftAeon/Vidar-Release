// Marquee and eyedropper cancel paths (review-pack D2): a drag under 4 px (ocr-empty) keeps the
// marquee armed; the overlay's Esc / right-click (ocr-cancel) and the eyedropper's Esc release the button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

const state = {
  prefs: new Map([
    ['modules.hidden', []],
    ['order.tools', ['marquee', 'eyedropper']],
  ]),
  calls: [],
  args: [],
  listeners: new Map(),
};
globalThis.__toolbarCancel = state;

const { window, flush } = setupDom({
  stubs: {
    prefs: `export const getPref = (key) => globalThis.__toolbarCancel.prefs.get(key);
      export const setPref = (key, value) => { globalThis.__toolbarCancel.prefs.set(key, value); return true; };`,
    ipc: `export const invoke = (command, args) => {
        globalThis.__toolbarCancel.calls.push(command);
        globalThis.__toolbarCancel.args.push(args);
        return Promise.resolve('');
      };
      export const listen = (event, callback) => {
        const state = globalThis.__toolbarCancel;
        const handlers = state.listeners.get(event) ?? new Set();
        handlers.add(callback);
        state.listeners.set(event, handlers);
        return Promise.resolve(() => { handlers.delete(callback); });
      };`,
    'panels/inspect': 'export const exitInspect = () => {}; export const onInspectEnter = () => {};',
    'panels/sessions': `export const getActiveSessionId = () => 'tab-a';
      export const writeToActive = async () => true;
      export const focusActive = () => {};`,
    'panels/workbench': 'export const revealWorkbench = () => {};',
    'panels/workbench-tray': 'export const addTextBlock = () => ({ ok: true });',
    clipboard: 'export const copyText = async () => true;',
    'icon-img': 'export const iconImg = () => document.createElement("span");',
  },
});

const { createToolRegistry } = await import('../src/tools/registry.ts');
const { initToolbench } = await import('../src/panels/toolbench.ts');

const emit = (event) => { for (const fn of [...(state.listeners.get(event) ?? [])]) fn({ payload: undefined }); };
const button = (grid, key) => grid.querySelector(`button[data-key="${key}"]`);

test('a tiny marquee drag keeps the tool armed; the overlay cancel releases it', async () => {
  const grid = document.createElement('div');
  const options = document.createElement('div');
  document.body.append(grid, options);
  await initToolbench(grid, options, createToolRegistry());
  await flush();
  button(grid, 'marquee').click();
  assert.equal(button(grid, 'marquee').getAttribute('aria-pressed'), 'true');
  assert.equal(state.calls.at(-1), 'ocr_begin');

  emit('ocr-empty');
  assert.equal(button(grid, 'marquee').getAttribute('aria-pressed'), 'true', 'a stray click does not end the tool');
  assert.equal(options.querySelector('#mq-stat').textContent, '—');

  emit('ocr-cancel');
  assert.equal(button(grid, 'marquee').getAttribute('aria-pressed'), 'false', 'Esc or right-click on the overlay ends it');
});

test('Esc while the eyedropper samples releases its button', async () => {
  const grid = document.createElement('div');
  const options = document.createElement('div');
  document.body.append(grid, options);
  await initToolbench(grid, options, createToolRegistry());
  await flush();
  button(grid, 'eyedropper').click();
  assert.equal(button(grid, 'eyedropper').getAttribute('aria-pressed'), 'true');
  assert.equal(document.body.classList.contains('eyedrop-mode'), true);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(button(grid, 'eyedropper').getAttribute('aria-pressed'), 'false');
  assert.equal(document.body.classList.contains('eyedrop-mode'), false);
});

test('the overlay losing focus asks ocr_cancel for a blur, not an explicit end', async () => {
  for (const id of ['box', 'size', 'hint']) {
    const el = document.createElement('div');
    el.id = id;
    document.body.append(el);
  }
  await import('../src/overlay.ts');
  state.calls.length = 0;
  state.args.length = 0;
  window.dispatchEvent(new window.Event('blur'));
  assert.deepEqual(state.calls, ['ocr_cancel']);
  assert.deepEqual(state.args[0], { blur: true });
  state.calls.length = 0;
  state.args.length = 0;
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(state.calls, ['ocr_cancel']);
  assert.deepEqual(state.args[0], {}, 'Esc stays an explicit end');
});
