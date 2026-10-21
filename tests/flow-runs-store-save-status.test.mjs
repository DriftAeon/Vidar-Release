// saveRunsEnvelope/
// backupInvalidRunsEnvelope return whether the write succeeded, and backupInvalidRunsEnvelope
// prunes older `.bak-<stamp>` keys — same shape as flow-store-save-status.test.mjs's coverage
// of store-core.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveRunsEnvelope, backupInvalidRunsEnvelope, RUNS_KEY } from '../src/flow/runs-core.ts';

const MAX_BAK_PER_KEY = 5; // restated — runs-core.ts keeps its own const, not exported

function mapStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

function throwingStorage() {
  return {
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
  };
}

test('saveRunsEnvelope: returns true on success, false when the write throws', () => {
  assert.equal(saveRunsEnvelope(mapStorage(), { v: 1, runs: [] }), true);
  assert.equal(saveRunsEnvelope(throwingStorage(), { v: 1, runs: [] }), false);
});

test('backupInvalidRunsEnvelope: returns true on success, false when the write throws', () => {
  const now = '2026-09-25T00:00:00.000Z';
  assert.equal(backupInvalidRunsEnvelope(mapStorage(), '{not json', now), true);
  assert.equal(backupInvalidRunsEnvelope(throwingStorage(), '{not json', now), false);
});

test('backupInvalidRunsEnvelope: keeps only the newest MAX_BAK_PER_KEY backups', () => {
  const storage = mapStorage();
  const stamps = [];
  for (let i = 0; i < MAX_BAK_PER_KEY + 3; i++) {
    const now = `2026-09-25T00:00:${String(i).padStart(2, '0')}.000Z`;
    stamps.push(now.replace(/[:.]/g, '-'));
    backupInvalidRunsEnvelope(storage, `raw-${i}`, now);
  }
  const bakKeys = [...storage._map.keys()].filter((k) => k.startsWith(`${RUNS_KEY}.bak-`));
  assert.equal(bakKeys.length, MAX_BAK_PER_KEY);
  for (const suffix of stamps.slice(-MAX_BAK_PER_KEY)) {
    assert.ok(storage._map.has(`${RUNS_KEY}.bak-${suffix}`), `expected ${suffix} to survive`);
  }
  for (const suffix of stamps.slice(0, stamps.length - MAX_BAK_PER_KEY)) {
    assert.ok(!storage._map.has(`${RUNS_KEY}.bak-${suffix}`), `expected ${suffix} to be pruned`);
  }
});

test('backupInvalidRunsEnvelope: a failed backup write is never listed in the bak index', () => {
  const storage = mapStorage();
  const realSetItem = storage.setItem;
  storage.setItem = (k, v) => {
    if (k.includes('.bak-')) throw new Error('quota exceeded');
    realSetItem(k, v);
  };
  const ok = backupInvalidRunsEnvelope(storage, 'bad', '2026-09-25T00:00:00.000Z');
  assert.equal(ok, false);
  assert.equal(storage.getItem(`${RUNS_KEY}.bakindex`), null, 'a backup that never landed must not be indexed');
});

test('backupInvalidRunsEnvelope: a same-`now` double call does not double-list the suffix in the bak index', () => {
  const storage = mapStorage();
  const now = '2026-09-25T00:00:00.000Z';
  backupInvalidRunsEnvelope(storage, 'bad-1', now);
  backupInvalidRunsEnvelope(storage, 'bad-2', now);
  const suffix = now.replace(/[:.]/g, '-');
  const list = JSON.parse(storage.getItem(`${RUNS_KEY}.bakindex`));
  assert.deepEqual(list, [suffix], 'the suffix must be listed once, not once per call');
  assert.equal(storage.getItem(`${RUNS_KEY}.bak-${suffix}`), 'bad-2');
});
