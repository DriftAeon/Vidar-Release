import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

const dom = setupDom({
  stubs: {
    'panels/workbench-bridge': `export const publishBlock = () => {}; export const publishEntry = () => {};
      export const restoreTray = async () => {};`,
    'panels/workbench-actions': 'export const copyContent = async () => {}; export const copyPathAction = async () => {};',
    'modules/names': 'export const moduleName = (id, builtin) => builtin;',
  },
  answers: {
    read_drop_text: (a) => ({ name: a.path.split('\\').pop(), bytes: 4, text: 'text', truncated: false, lossy: false }),
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

test('An html file block shows Open in Browser after Copy Path and before Annotate', async () => {
  tray.dropPaths(['C:\\mocks\\card.html']);
  await dom.flush();
  const names = [...document.querySelectorAll('.wb-block-name')].map((n) => n.textContent);
  const labels = labelsOf(names[0]);
  assert.ok(labels.includes('Open in Browser'), labels.join('|'));
  assert.ok(labels.indexOf('Open in Browser') > labels.indexOf('Copy Path'));
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
