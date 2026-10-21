// Regression: the Documents Open menu lists none of the ungrouped bridge\display entries (2026-10-11),
// and display\reviews entries list as their own Reviews folder.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    "icons": "export function lucide() { return document.createElement('span'); }",
  },
  answers: { patch_state: undefined },
});
const { mountOpenMenu, setCatalog, closeOpenMenu } = await import('../src/panels/document-open-menu.ts');
const openedDocuments = [];
const picker = document.createElement('button');
document.body.append(picker);
mountOpenMenu(picker, {
  onNew() {}, onOpen: (path) => openedDocuments.push(path), openPath: () => undefined,
});
await dom.flush();
const entry = (path, mtime_ms = 100) => ({ path, kind: path.split('.').pop(), mtime_ms });
const md = entry('D:\\display\\Notes.md');
const menuFiles = () => [...document.querySelectorAll('.doc-om-file')];

test('Documents lists no ungrouped bridge\\display entries, even after a late list_documents or display-update', async () => {
  const inbox = { ...entry('D:\\docs\\inbox\\Note.md', 500), group: 'Inbox' };
  // list_documents carrying ungrouped bridge\display docs beside real groups
  setCatalog([inbox, md]);
  picker.click();
  assert.equal(document.querySelector('.doc-om-fold[data-folder="bridge\\\\display"]'), null, 'no Display folder');
  assert.deepEqual([...document.querySelectorAll('.doc-om-fold')].map((f) => f.dataset.folder), ['Inbox']);
  assert.equal(document.querySelector('.doc-om-folders .doc-om-rule'), null, 'no rule before a Display folder');
  assert.deepEqual(menuFiles().map((r) => r.dataset.value), [inbox.path]);
  assert.equal(picker.querySelector('.doc-open-count').textContent, '1');
  menuFiles()[0].click();
  assert.deepEqual(openedDocuments, [inbox.path]);
  assert.equal(document.querySelector('#doc-om'), null, 'selection closes the dropdown');
  // only ungrouped entries: nothing to list
  setCatalog([md]);
  assert.equal(picker.querySelector('.doc-open-count').textContent, '');
  closeOpenMenu();
});

test('Documents lists display\\reviews entries as a Reviews folder, never the ungrouped display docs', async () => {
  const inbox = { ...entry('D:\\docs\\inbox\\Note.md', 500), group: 'Inbox' };
  const review = { ...entry('D:\\display\\reviews\\Finding.md', 600), group: 'Reviews' };
  setCatalog([inbox, review, md]);
  picker.click();
  const folds = [...document.querySelectorAll('.doc-om-fold')];
  assert.deepEqual(folds.map((f) => f.dataset.folder), ['Inbox', 'Reviews']);
  assert.equal(folds[1].querySelector('.nm').textContent, 'Reviews');
  folds[1].click();
  assert.deepEqual(menuFiles().map((r) => r.dataset.value), [review.path], 'ungrouped display md stays out');
  const before = openedDocuments.length;
  menuFiles()[0].click();
  assert.deepEqual(openedDocuments.slice(before), [review.path]);
  setCatalog([md]);
  closeOpenMenu();
});
