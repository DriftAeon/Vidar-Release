// src/unreal/asset.ts: override query parsing and the card / find display mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOverrideQuery, cardRows, findView } from '../src/unreal/asset.ts';

test('parseOverrideQuery', () => {
  assert.deepEqual(parseOverrideQuery(' BP_Hero.Health '), { cls: 'BP_Hero', field: 'Health' });
  for (const bad of ['', 'Hero', 'A.B.C', '.B', 'A.', ' . ']) assert.equal(parseOverrideQuery(bad), null, bad);
});

test('cardRows maps fields, props, last change and notes', () => {
  const rows = cardRows({
    path: '/Game/A', objectName: 'A', parentClass: null, assetClass: 'Blueprint',
    props: [{ name: 'Speed', typeName: 'float', value: '3' }],
    lastChange: { sha: 'abc1234', author: 'Ann', when: '2d ago' },
    notes: ['Rider Read No Properties', 'Other'],
  });
  assert.deepEqual(rows.slice(0, 5).map((r) => [r.label, r.value]), [
    ['Path', '/Game/A'], ['Object', 'A'], ['Parent Class', ''], ['Asset Class', 'Blueprint'],
    ['Last Change', 'abc1234 · Ann · 2d ago'],
  ]);
  assert.deepEqual([rows[5].label, rows[5].value, rows[5].tooltip], ['Speed', '3', 'float']);
  assert.equal(rows[6].dim, true);
  assert.match(rows[6].tooltip, /does not prove/);
  assert.equal(rows[7].tooltip, undefined);
});

test('findView status mapping', () => {
  const row = { assetPath: '/Game/A', name: 'A', detail: null };
  assert.equal(findView({ status: 'noMatches', rows: [], message: null }).message, 'No Matches');
  assert.equal(findView({ status: 'verifiedNone', rows: [], message: 'Checked 4 assets' }).message, 'Checked 4 assets');
  const bad = findView({ status: 'checkDidntRun', rows: [row], message: 'Rider is down' });
  assert.deepEqual([bad.message, bad.rows.length, bad.rows[0].detail], ['Rider is down', 1, '']);
  assert.equal(findView({ status: 'matches', rows: [row], message: null }).message, null);
  assert.equal(findView({ status: 'overrides', rows: [row], message: null }).rows[0].assetPath, '/Game/A');
});
