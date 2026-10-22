import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

const dom = setupDom({
  stubs: {
    'panels/workbench-bridge': `export const publishBlock = () => {}; export const publishEntry = () => {};
      export const restoreTray = async () => {};`,
    'panels/workbench-actions': 'export const copyContent = async () => {}; export const copyPathAction = async () => {};\n      export const ensureSaved = async (b) => { globalThis.__saves = (globalThis.__saves ?? 0) + 1; b.path = b.path ?? "C:\\\\clips\\\\x.png"; return b.path; };',
    'modules/names': 'export const moduleName = (id, builtin) => builtin;',
  },
  answers: {
    read_drop_text: (a) => ({ name: a.path.split('\\').pop(), bytes: 4, text: 'text', truncated: false, lossy: false }),
    open_in_browser: (a) => { (globalThis.__opened ??= []).push(a.path); },
    read_drop_png: new Uint8Array([137, 80, 78, 71]).buffer,
  },
});
const tray = await import('../src/panels/workbench-tray.ts');
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
document.body.innerHTML ='<div id="tray"></div>';
tray.mountTray(document.querySelector('#tray'), {
  note() {}, openInDocument() {}, revealWorkbench() {}, trayActive: () => true,
});

const labelsOf = (name) => {
  const block = [...document.querySelectorAll('.wb-block')].find((el) => el.querySelector('.wb-block-name')?.textContent === name);
  return [...block.querySelectorAll('.wb-actions > button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
};

test('An html file block shows Open in Browser at the far left of the bar, Annotate last', async () => {
  tray.dropPaths(['C:\\mocks\\card.html']);
  await dom.flush();
  const names = [...document.querySelectorAll('.wb-block-name')].map((n) => n.textContent);
  const labels = labelsOf(names[0]);
  assert.ok(labels.includes('Open in Browser'), labels.join('|'));
  assert.equal(labels.indexOf('Open in Browser'), 0, 'far left, ahead of Copy');
  assert.ok(labels.indexOf('Open in Browser') < labels.length - 1, 'Annotate stays last');
});

test('A .txt file block and a pasted text block have no Open in Browser', async () => {
  tray.dropPaths(['C:\\notes\\a.txt']);
  tray.addTextBlock('pasted', 'paste');
  await dom.flush();
  const names = [...document.querySelectorAll('.wb-block-name')].map((n) => n.textContent);
  assert.equal(names.length, 3);
  for (const n of names.slice(1)) assert.ok(!labelsOf(n).includes('Open in Browser'), n);
});

test('A pasted image with no file shows Open in Browser; a click saves once, then opens the saved path', async () => {
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  tray.onPaste({
    target: null, preventDefault() {},
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => blob }], getData: () => '' },
  });
  await dom.flush();
  const blocks = [...document.querySelectorAll('.wb-block')];
  const block = blocks[blocks.length - 1];
  const btn = [...block.querySelectorAll('.wb-actions > button')].find((x) => x.getAttribute('aria-label') === 'Open in Browser');
  assert.ok(btn, 'button present with no file');
  assert.equal(btn.disabled, false);
  btn.click();
  await dom.flush();
  btn.click();
  await dom.flush();
  assert.equal(globalThis.__saves, 1, 'one save; the second click reuses b.path');
  assert.deepEqual(globalThis.__opened, ['C:\\clips\\x.png', 'C:\\clips\\x.png']);
});

test('A dropped .png file shows Open in Browser', async () => {
  tray.dropPaths(['C:\\shots\\reply.png']);
  await dom.flush();
  const names = [...document.querySelectorAll('.wb-block-name')].map((n) => n.textContent);
  assert.ok(labelsOf(names[names.length - 1]).includes('Open in Browser'));
});
