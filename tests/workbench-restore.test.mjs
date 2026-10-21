import test from 'node:test';
import assert from 'node:assert/strict';
import { entryToRestore, blockToEntry } from '../src/panels/workbench-restore.ts';

test('inline text entry restores as a text block', () => {
  const r = entryToRestore({ name: 'Alpha', kind: 'text', source: 'paste', at: 100, previewBytes: 5, text: 'hi' });
  assert.deepEqual(r, { name: 'Alpha', at: 100, source: 'paste', mode: 'text', text: 'hi', truncated: false });
});

test('truncated text entry carries the flag through', () => {
  const r = entryToRestore({ name: 'Bravo', kind: 'text', source: 'paste', at: 200, previewBytes: 5, text: 'hi', truncated: true });
  assert.equal(r.mode, 'text');
  assert.equal(r.truncated, true);
});

test('a path wins over kind: a dropped file (text or png) restores by re-reading the path', () => {
  const rText = entryToRestore({ name: 'Charlie', kind: 'text', source: 'drop', at: 300, previewBytes: 5, path: 'C:\\a.md' });
  assert.deepEqual(rText, { name: 'Charlie', at: 300, source: 'drop', mode: 'file', path: 'C:\\a.md' });
  const rPng = entryToRestore({ name: 'Delta', kind: 'png', source: 'drop', at: 400, previewBytes: 5, path: 'C:\\a.png' });
  assert.deepEqual(rPng, { name: 'Delta', at: 400, source: 'drop', mode: 'file', path: 'C:\\a.png' });
});

test('a path-less png entry restores by reading the bytes back', () => {
  const r = entryToRestore({ name: 'Echo', kind: 'png', source: 'marquee', at: 500, previewBytes: 5 });
  assert.deepEqual(r, { name: 'Echo', at: 500, source: 'marquee', mode: 'png' });
});

test('the document entry is left untouched — the Document tab owns it', () => {
  const r = entryToRestore({ name: 'document', kind: 'document', path: 'C:\\a.md', title: 'a.md' });
  assert.equal(r, null);
});

test('junk is left untouched: unknown kind, missing name, missing at, or a non-object', () => {
  assert.equal(entryToRestore({ name: 'Foxtrot', kind: 'audio', at: 1 }), null);
  assert.equal(entryToRestore({ kind: 'text', at: 1 }), null);
  assert.equal(entryToRestore({ name: 'Golf', kind: 'text' }), null);
  assert.equal(entryToRestore(null), null);
  assert.equal(entryToRestore('not an object'), null);
  assert.equal(entryToRestore(42), null);
});

test('an unrecognised source falls back to "paste" rather than dropping the entry', () => {
  const r = entryToRestore({ name: 'Hotel', kind: 'text', source: 'unknown-source', at: 1, text: 'x' });
  assert.equal(r.source, 'paste');
});

test('blockToEntry round-trips a pasted text block\'s text through entryToRestore', () => {
  const textBlock = { name: 'India', kind: 'text', source: 'paste', at: 600, previewBytes: 5, text: 'hello there' };
  const restored = entryToRestore(blockToEntry(textBlock));
  assert.equal(restored.text, textBlock.text);
});

test('blockToEntry omits text for a path-backed block (the path is re-read instead)', () => {
  const fileBlock = { name: 'Juliet', kind: 'text', source: 'drop', at: 700, previewBytes: 5, path: 'C:\\a.md', text: 'unused' };
  const entry = blockToEntry(fileBlock);
  assert.equal(entry.text, undefined);
  assert.equal(entryToRestore(entry).mode, 'file');
});

test('the fold state round-trips; an unfolded block carries no collapsed key', () => {
  const base = { name: 'Kilo', kind: 'text', source: 'paste', at: 800, previewBytes: 5, text: 'x' };
  assert.equal(entryToRestore(blockToEntry({ ...base, collapsed: true })).collapsed, true);
  assert.equal('collapsed' in blockToEntry(base), false);
  assert.equal('collapsed' in entryToRestore(blockToEntry(base)), false);
  assert.equal('collapsed' in entryToRestore({ ...blockToEntry(base), collapsed: 'yes' }), false);
});
