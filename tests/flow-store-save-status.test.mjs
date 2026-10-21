// saveGraphsEnvelope/
// saveTemplatesEnvelope/backupInvalidEnvelope return whether the write succeeded, and
// backupInvalidEnvelope prunes older `.bak-<stamp>` keys down to MAX_BAK_PER_KEY per key.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveGraphsEnvelope,
  saveTemplatesEnvelope,
  backupInvalidEnvelope,
  stampGraph,
  GRAPHS_KEY,
  MAX_BAK_PER_KEY,
} from '../src/flow/store-core.ts';
import { STARTER_TEMPLATES } from '../src/flow/templates.ts';

const NOW = '2026-09-25T00:00:00.000Z';

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

test('saveGraphsEnvelope: returns true on a successful write', () => {
  const storage = mapStorage();
  const graph = stampGraph({ nodes: [], edges: [] }, NOW);
  assert.equal(saveGraphsEnvelope(storage, { v: 1, activeGraphId: graph.id, graphs: [graph] }), true);
});

test('saveGraphsEnvelope: returns false when the underlying write throws', () => {
  const graph = stampGraph({ nodes: [], edges: [] }, NOW);
  assert.equal(saveGraphsEnvelope(throwingStorage(), { v: 1, activeGraphId: graph.id, graphs: [graph] }), false);
});

test('saveTemplatesEnvelope: returns true/false to match the write outcome', () => {
  assert.equal(saveTemplatesEnvelope(mapStorage(), { v: 1, templates: STARTER_TEMPLATES }), true);
  assert.equal(saveTemplatesEnvelope(throwingStorage(), { v: 1, templates: STARTER_TEMPLATES }), false);
});

test('backupInvalidEnvelope: returns true on success and false when the write throws', () => {
  assert.equal(backupInvalidEnvelope(mapStorage(), GRAPHS_KEY, '{not json', NOW), true);
  assert.equal(backupInvalidEnvelope(throwingStorage(), GRAPHS_KEY, '{not json', NOW), false);
});

test('backupInvalidEnvelope: keeps only the newest MAX_BAK_PER_KEY backups for a key', () => {
  const storage = mapStorage();
  const stamps = [];
  for (let i = 0; i < MAX_BAK_PER_KEY + 3; i++) {
    const now = `2026-09-25T00:00:${String(i).padStart(2, '0')}.000Z`;
    stamps.push(now.replace(/[:.]/g, '-'));
    backupInvalidEnvelope(storage, GRAPHS_KEY, `raw-${i}`, now);
  }
  const bakKeys = [...storage._map.keys()].filter((k) => k.startsWith(`${GRAPHS_KEY}.bak-`));
  assert.equal(bakKeys.length, MAX_BAK_PER_KEY);
  // the newest MAX_BAK_PER_KEY stamps survive; the oldest ones are gone
  const survivingSuffixes = stamps.slice(-MAX_BAK_PER_KEY);
  for (const suffix of survivingSuffixes) {
    assert.ok(storage._map.has(`${GRAPHS_KEY}.bak-${suffix}`), `expected ${suffix} to survive`);
  }
  for (const suffix of stamps.slice(0, stamps.length - MAX_BAK_PER_KEY)) {
    assert.ok(!storage._map.has(`${GRAPHS_KEY}.bak-${suffix}`), `expected ${suffix} to be pruned`);
  }
});

test('backupInvalidEnvelope: a failed backup write is never listed in the bak index', () => {
  const storage = mapStorage();
  const realSetItem = storage.setItem;
  storage.setItem = (k, v) => {
    if (k.includes('.bak-')) throw new Error('quota exceeded');
    realSetItem(k, v);
  };
  const ok = backupInvalidEnvelope(storage, GRAPHS_KEY, '{bad', NOW);
  assert.equal(ok, false);
  assert.equal(storage.getItem(`${GRAPHS_KEY}.bakindex`), null, 'a backup that never landed must not be indexed');
});

test('backupInvalidEnvelope: a same-`now` double call does not double-list the suffix in the bak index', () => {
  const storage = mapStorage();
  backupInvalidEnvelope(storage, GRAPHS_KEY, '{bad-1', NOW);
  backupInvalidEnvelope(storage, GRAPHS_KEY, '{bad-2', NOW);
  const suffix = NOW.replace(/[:.]/g, '-');
  const list = JSON.parse(storage.getItem(`${GRAPHS_KEY}.bakindex`));
  assert.deepEqual(list, [suffix], 'the suffix must be listed once, not once per call');
  // the second call's write is still the one that landed under that key
  assert.equal(storage.getItem(`${GRAPHS_KEY}.bak-${suffix}`), '{bad-2');
});
