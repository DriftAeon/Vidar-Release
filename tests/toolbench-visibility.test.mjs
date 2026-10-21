import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

const state = {
  prefs: new Map([
    ['modules.hidden', ['tool:marquee']],
    ['order.tools', ['eyedropper', 'marquee']],
  ]),
  activeSession: 'tab-a',
  writes: [],
  calls: [],
  listeners: new Map(),
};
globalThis.__toolbarVisibility = state;

const { window, ledger, flush } = setupDom({
  stubs: {
    prefs: `export const getPref = (key) => globalThis.__toolbarVisibility.prefs.get(key);
      export const setPref = (key, value) => { globalThis.__toolbarVisibility.prefs.set(key, value); return true; };`,
    ipc: `export const invoke = (command) => {
        globalThis.__toolbarVisibility.calls.push(command);
        return Promise.resolve('');
      };
      export const listen = (event, callback) => {
        const state = globalThis.__toolbarVisibility;
        state.calls.push('listen:' + event);
        const handlers = state.listeners.get(event) ?? new Set();
        handlers.add(callback);
        state.listeners.set(event, handlers);
        return Promise.resolve(() => { handlers.delete(callback); state.calls.push('off:' + event); });
      };`,
    'panels/inspect': 'export const exitInspect = () => {}; export const onInspectEnter = () => {};',
    'panels/sessions': `export const getActiveSessionId = () => globalThis.__toolbarVisibility.activeSession;
      export const writeToActive = async (text) => {
        const state = globalThis.__toolbarVisibility;
        state.writes.push({ session: state.activeSession, text });
        return true;
      };
      export const focusActive = () => {};`,
    'panels/workbench': 'export const revealWorkbench = () => {};',
    'panels/workbench-tray': 'export const addTextBlock = () => ({ ok: true });',
    clipboard: 'export const copyText = async () => true;',
    'icon-img': 'export const iconImg = () => document.createElement("span");',
  },
});

const { createToolRegistry } = await import('../src/tools/registry.ts');
const { initToolbench, setToolVisibility, syncToolVisibility, syncToolOrder } = await import('../src/panels/toolbench.ts');

const activeOcrListeners = () => [...state.listeners.values()].reduce((total, handlers) => total + handlers.size, 0);
const buttons = (grid) => [...grid.querySelectorAll('button')];

test('hidden tools mount once, saved order applies, and off disarms before listener cleanup', async () => {
  const grid = document.createElement('div');
  const options = document.createElement('div');
  document.body.append(grid, options);
  await initToolbench(grid, options, createToolRegistry());
  await flush();
  assert.deepEqual(buttons(grid).map((button) => button.dataset.key), ['eyedropper']);
  assert.equal(activeOcrListeners(), 0);

  assert.equal(await setToolVisibility('marquee', true), true);
  await flush();
  assert.deepEqual(buttons(grid).map((button) => button.dataset.key), ['eyedropper', 'marquee']);
  assert.equal(activeOcrListeners(), 4);
  buttons(grid)[1].click();
  assert.equal(state.calls.at(-1), 'ocr_begin');
  assert.equal(await setToolVisibility('marquee', false), true);
  assert.equal(activeOcrListeners(), 0);
  assert.deepEqual(buttons(grid).map((button) => button.dataset.key), ['eyedropper']);
  assert.ok(state.calls.indexOf('ocr_cancel') < state.calls.indexOf('off:ocr-result'));

  assert.equal(await setToolVisibility('marquee', true), true);
  assert.equal(await setToolVisibility('marquee', true), true);
  await flush();
  assert.equal(activeOcrListeners(), 4);
  assert.equal(state.calls.filter((call) => call === 'listen:ocr-result').length, 2);
  assert.deepEqual(buttons(grid).map((button) => button.dataset.key), ['eyedropper', 'marquee']);
});

test('preference reconciliation and the marquee strip follow the current state', async () => {
  const grid = document.createElement('div');
  const options = document.createElement('div');
  document.body.append(grid, options);
  state.prefs.set('modules.hidden', []);
  state.prefs.set('order.tools', ['marquee', 'eyedropper']);
  await initToolbench(grid, options, createToolRegistry());
  await flush();
  assert.deepEqual(buttons(grid).map((button) => button.dataset.key), ['marquee', 'eyedropper']);
  state.prefs.set('order.tools', ['eyedropper', 'marquee']);
  syncToolOrder();
  assert.deepEqual(buttons(grid).map((button) => button.dataset.key), ['eyedropper', 'marquee']);

  buttons(grid)[1].click();
  options.querySelector('#mq-text').value = 'Selected text';
  options.querySelector('#mq-text').dispatchEvent(new window.Event('input', { bubbles: true }));
  // Insert Into Session and Save as Clip were removed (2026-10-16); Copy follows the text
  assert.equal(options.querySelector('#mq-insert'), null);
  assert.equal(options.querySelector('#mq-clip'), null);
  assert.equal(options.querySelector('#mq-copy').disabled, false);

  state.prefs.set('modules.hidden', ['tool:marquee']);
  await syncToolVisibility();
  assert.deepEqual(buttons(grid).map((button) => button.dataset.key), ['eyedropper']);
  assert.equal(activeOcrListeners(), 0);
});

test('eyedropper removal retires sampling listeners and right-click still cancels', async () => {
  const grid = document.createElement('div');
  const options = document.createElement('div');
  document.body.append(grid, options);
  state.prefs.set('modules.hidden', ['tool:marquee']);
  await initToolbench(grid, options, createToolRegistry());

  buttons(grid)[0].click();
  assert.equal(document.body.classList.contains('eyedrop-mode'), true);
  assert.equal(ledger.types().includes('contextmenu'), true);
  document.body.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  assert.equal(document.body.classList.contains('eyedrop-mode'), false);

  buttons(grid)[0].click();
  assert.equal(await setToolVisibility('eyedropper', false), true);
  assert.equal(document.body.classList.contains('eyedrop-mode'), false);
  assert.equal(ledger.types().includes('contextmenu'), false);
  assert.deepEqual(buttons(grid), []);
});
