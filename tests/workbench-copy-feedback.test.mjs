import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

const fileActions = new URL('../src/panels/file-actions.ts', import.meta.url).href;
const dom = setupDom({ stubs: {
  ipc: 'export const invoke = async () => {}; export const getCurrentWebview = () => ({ onDragDropEvent: () => Promise.reject("boom") });',
  clipboard: 'export const copyText = async () => true;',
  'panels/sessions': 'export const openWorkbench = () => {}; export const isWorkbenchOpen = () => true;',
  'panels/document': `import { copyPathButton } from ${JSON.stringify(fileActions)};
    export function mountDocumentView(parent, note) {
      const view = document.createElement('div');
      view.append(copyPathButton({ path: () => 'C:\\example\\note.md', note }));
      parent.append(view); return view;
    }
    export const openDocumentPath = async () => true;
    export const onDocumentShown = () => {}; export const onDocumentHidden = () => {};`,
  'panels/flow': 'export const mountFlowView = () => document.createElement("div"); export const onFlowShown = () => {}; export const onFlowHidden = () => {};',
  'panels/runes': 'export const mountRunesView = () => document.createElement("div"); export const onRunesShown = () => {}; export const onRunesHidden = () => {};',
  'panels/lab': 'export const mountLabView = () => document.createElement("div"); export const onLabShown = () => {}; export const onLabHidden = () => {};',
  'panels/relay': 'export const mountRelayTab = () => document.createElement("div"); export const onRelayShown = () => {}; export const onRelayHidden = () => {};',
  'panels/reorder': 'export const applyOrder = () => {}; export const enableReorder = () => {};',
  'panels/workbench-tab-icons': 'export const tabIcon = () => document.createElement("img");',
  'modules/names': 'export const moduleName = (id, builtin) => builtin; export const onModuleNamesChange = () => () => {};',
  'panels/workbench-tray': 'export const mountTray = () => {}; export const onPaste = () => {}; export const dropPaths = () => {}; export const TRAY_LANDED_NOTE = "Added To Tray";',
} });
const { mountWorkbench } = await import('../src/panels/workbench.ts');

const calls = [];
document.body.innerHTML = '<section id="toolbench"><div id="tool-grid"></div></section>';
mountWorkbench(document.body, { open() { calls.push('open'); }, collapse() { calls.push('collapse'); } });
const { setWorkbenchShown } = await import('../src/panels/workbench.ts');

test('A mount-time note shows as a toast, not in the head', async () => {
  await dom.flush();
  assert.equal(document.querySelector('#workbench-note'), null);
  assert.equal(document.querySelector('#zoom-toast').textContent, 'Drop Unavailable: boom');
});

test('Copy Path feedback shows as a toast', async () => {
  document.querySelector('.wb-tab[data-tab="doc"]').click();
  document.querySelector('button[aria-label="Copy Path"]').click();
  await dom.flush();
  assert.equal(document.querySelector('#zoom-toast').textContent, 'Path Copied');
});

test('The rail toggle sits above the tool grid and follows the bench state', () => {
  const toggle = document.querySelector('#toolbench > #wb-toggle');
  assert.equal(toggle.nextElementSibling.id, 'tool-grid');
  assert.equal(toggle.getAttribute('aria-label'), 'Open Bench');
  assert.equal(toggle.title, 'Open Bench (Ctrl+\\)');
  assert.match(toggle.querySelector('img.icn').src, /bench-expand\.svg$/);
  toggle.click();
  setWorkbenchShown(true);
  assert.equal(toggle.getAttribute('aria-label'), 'Collapse Bench');
  assert.equal(toggle.title, 'Collapse Bench (Ctrl+\\)');
  assert.match(toggle.querySelector('img.icn').src, /bench-collapse\.svg$/);
  toggle.click();
  assert.deepEqual(calls, ['open', 'collapse']);
});
