// Changes Asset Diff helpers (src/changes/asset-diff.ts): which rows get the button and how a
// result maps to slot lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, isAssetFile, slotKey } from '../src/changes/asset-diff.ts';

test('isAssetFile matches .uasset and .umap, any case', () => {
  assert.equal(isAssetFile('Content/Maps/L.umap'), true);
  assert.equal(isAssetFile('Content/A/BP_X.UASSET'), true);
  assert.equal(isAssetFile('Content/A/BP_X.uasset.meta'), false);
  assert.equal(isAssetFile('src/main.cpp'), false);
});

test('diffLines maps rows old to new, null as empty', () => {
  const d = { status: 'changed', rows: [
    { name: 'Health', typeName: 'float', old: '1', new: '2' },
    { name: 'Tag', typeName: 'Name', old: null, new: 'A' },
  ], notes: ['partial read'] };
  assert.deepEqual(diffLines(d), [
    { text: 'Health: 1 → 2', tip: 'float', dim: false },
    { text: 'Tag:  → A', tip: 'Name', dim: false },
    { text: 'partial read', tip: null, dim: true },
  ]);
});

test('diffLines status lines', () => {
  assert.equal(diffLines({ status: 'noChanges', rows: [], notes: [] })[0].text, 'No Property Changes');
  const u = diffLines({ status: 'unknown', rows: [{ name: 'a', typeName: 't', old: 'x', new: null }], notes: [] });
  assert.equal(u[0].text, 'Changes Unknown');
  assert.equal(u[1].text, 'a: x → ');
});

test('slotKey separates staged from changes', () => {
  assert.equal(slotKey(true, 'a.uasset'), 'staged:a.uasset');
  assert.equal(slotKey(false, 'a.uasset'), 'changes:a.uasset');
});
