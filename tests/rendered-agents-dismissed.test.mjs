import test from 'node:test';
import assert from 'node:assert/strict';
import { createDismissedStore, MAX_IDS, MAX_SESSIONS, MAX_AGE_MS } from '../src/panels/rendered/agents-dismissed.ts';

function make(startNow = 1000) {
  let m;
  let t = startNow;
  const store = createDismissedStore({ get: () => m, set: (v) => { m = v; }, now: () => t });
  return { store, tick: (ms) => { t += ms; }, map: () => m };
}

test('a dismissed task id is skipped on replay, in its own session only', () => {
  const { store } = make();
  store.add('s1', ['a', 'b']);
  assert.equal(store.has('s1', 'a'), true);
  assert.equal(store.has('s1', 'c'), false);
  assert.equal(store.has('s2', 'a'), false);
  assert.equal(store.has(null, 'a'), false);
});

test('bounds: ids per session, session count, and age', () => {
  const { store, tick, map } = make();
  store.add('s1', Array.from({ length: MAX_IDS + 5 }, (_, i) => `id${i}`));
  assert.equal(map().s1.ids.length, MAX_IDS);
  assert.equal(store.has('s1', 'id0'), false);
  assert.equal(store.has('s1', `id${MAX_IDS + 4}`), true);
  for (let i = 0; i < MAX_SESSIONS + 3; i++) { tick(1); store.add(`x${i}`, ['a']); }
  assert.ok(Object.keys(map()).length <= MAX_SESSIONS);
  assert.equal(store.has('x0', 'a'), false);
  tick(MAX_AGE_MS + 1);
  store.add('fresh', ['a']);
  assert.deepEqual(Object.keys(map()), ['fresh']);
});
