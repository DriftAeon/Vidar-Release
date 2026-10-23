import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewportMemory, VIEWPORTS_KEY } from '../src/flow/viewport-memory.ts';

function fakeStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

test('two graphs keep separate pan/zoom across a switch; an unknown id has none', () => {
  const mem = createViewportMemory(() => fakeStorage());
  mem.set('a', { panX: -200, panY: 10, scale: 0.5 });
  mem.set('b', { panX: 300, panY: -40, scale: 1.5 });
  assert.deepEqual(mem.get('a'), { panX: -200, panY: 10, scale: 0.5 });
  assert.deepEqual(mem.get('b'), { panX: 300, panY: -40, scale: 1.5 });
  assert.equal(mem.get('never-seen'), null);
  mem.flush();
});

test('views persist per graph id and a deleted graph is forgotten', () => {
  const st = fakeStorage();
  const mem = createViewportMemory(() => st);
  mem.set('a', { panX: 1, panY: 2, scale: 1 });
  mem.set('b', { panX: 3, panY: 4, scale: 2 });
  mem.flush();
  assert.ok(st.m.has(VIEWPORTS_KEY));

  const reloaded = createViewportMemory(() => st);
  assert.deepEqual(reloaded.get('a'), { panX: 1, panY: 2, scale: 1 });
  reloaded.forget('a');
  reloaded.flush();
  assert.equal(createViewportMemory(() => st).get('a'), null);
  assert.deepEqual(createViewportMemory(() => st).get('b'), { panX: 3, panY: 4, scale: 2 });
});

test('writes are debounced, not per pan frame', () => {
  const st = fakeStorage();
  let writes = 0;
  const orig = st.setItem;
  st.setItem = (k, v) => { writes++; orig(k, v); };
  const mem = createViewportMemory(() => st);
  for (let i = 0; i < 50; i++) mem.set('a', { panX: i, panY: 0, scale: 1 });
  assert.equal(writes, 0);
  mem.flush();
  assert.equal(writes, 1);
});

test('corrupt stored data yields no views', () => {
  const st = fakeStorage();
  st.m.set(VIEWPORTS_KEY, '{"v":1,"views":{"a":{"panX":"x","panY":0,"scale":1}}}');
  assert.equal(createViewportMemory(() => st).get('a'), null);
  st.m.set(VIEWPORTS_KEY, 'not json');
  assert.equal(createViewportMemory(() => st).get('a'), null);
});
