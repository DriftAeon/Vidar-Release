// Table over knip-gate's pure diff: new fails, baselined passes, fixed warns, staged filter drops other files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diff, keysOf } from './knip-gate.mjs';

const A = 'exports:src/a.ts:foo';
const B = 'exports:src/b.ts:bar';

const cases = [
  { name: 'new key is added', cur: [A], base: {}, staged: null, added: [A], fixed: [] },
  { name: 'baselined key passes', cur: [A], base: { [A]: 1 }, staged: null, added: [], fixed: [] },
  { name: 'fixed key is reported fixed', cur: [], base: { [A]: 1 }, staged: null, added: [], fixed: [A] },
  { name: 'multiset: a second copy is new', cur: [A, A], base: { [A]: 1 }, staged: null, added: [A], fixed: [] },
  { name: 'staged filter drops keys outside the list', cur: [A, B], base: {}, staged: ['src/b.ts'], added: [B], fixed: [] },
  { name: 'staged filter never hides a fixed key', cur: [], base: { [A]: 1 }, staged: ['src/b.ts'], added: [], fixed: [A] },
];

for (const c of cases) {
  test(c.name, () => assert.deepEqual(diff(c.cur, c.base, c.staged), { added: c.added, fixed: c.fixed }));
}

test('keysOf flattens knip JSON, joins duplicate groups, skips file', () => {
  const json = { issues: [{ file: 'src/a.ts', files: [{ name: 'src/a.ts' }], exports: [{ name: 'foo' }], duplicates: [[{ name: 'x' }, { name: 'y' }]] }] };
  assert.deepEqual(keysOf(json), ['duplicates:src/a.ts:x|y', 'exports:src/a.ts:foo', 'files:src/a.ts:src/a.ts']);
});
