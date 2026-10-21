// prefs-core.ts's cache, debounced
// write-back, and one-shot import of the old browser-storage keys (Flow's keys excluded).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PrefsStore,
  collectLegacy,
  MAX_STATE_BYTES,
} from '../src/prefs-core.ts';

function backend(initial = {}, { readFails = false, patchFails = false } = {}) {
  const file = { ...initial };
  const patches = [];
  return {
    file,
    patches,
    read: async () => {
      if (readFails) throw new Error('parse error');
      return { ...file };
    },
    patch: async (entries) => {
      patches.push(entries);
      if (patchFails) throw new Error('refused');
      for (const [k, v] of Object.entries(entries)) {
        if (v === null) delete file[k];
        else file[k] = v;
      }
    },
  };
}

// Manual timers: `fire()` runs the pending debounce, `pending` counts armed timers.
function fakeTimers() {
  let next = null;
  const t = {
    armed: 0,
    set(fn) { next = fn; t.armed++; return 1; },
    clear() { next = null; },
    fire() { const f = next; next = null; f?.(); },
    get pending() { return next !== null; },
  };
  return t;
}

function legacyStore(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

const flushed = () => new Promise((r) => setImmediate(r));

function make(initial, opts) {
  const b = backend(initial, opts);
  const timers = fakeTimers();
  const logs = [];
  const store = new PrefsStore(b, { timers, log: (m) => logs.push(m) });
  return { b, timers, logs, store };
}

test('cache: get is synchronous over what read_state returned', async () => {
  const { store } = make({ theme: 'panzer', 'rightbar.width': 300 });
  await store.init();
  assert.equal(store.get('theme'), 'panzer');
  assert.equal(store.get('rightbar.width'), 300);
  assert.equal(store.get('split.width'), undefined);
});

test('cache: a wrong-typed value in the file reads as absent (guarded get)', async () => {
  const { store } = make({ 'rightbar.width': 'wide', 'order.rack': [1, 2] });
  await store.init();
  assert.equal(store.get('rightbar.width'), undefined);
  assert.equal(store.get('order.rack'), undefined);
});

test('cache: set is visible to get immediately, before any write', async () => {
  const { store, b } = make();
  await store.init();
  store.set('theme', 'jager');
  assert.equal(store.get('theme'), 'jager');
  assert.equal(b.patches.length, 0);
});

test('debounce: several sets become one patch with whole values per key', async () => {
  const { store, b, timers } = make({ 'document.groups': { a: true } });
  await store.init();
  store.set('theme', 'zero');
  store.set('theme', 'panzer');
  store.set('document.groups', { a: true, b: true });
  assert.equal(timers.armed, 1, 'one timer for the burst');
  timers.fire();
  await flushed();
  assert.deepEqual(b.patches, [{ theme: 'panzer', 'document.groups': { a: true, b: true } }]);
  assert.deepEqual(b.file['document.groups'], { a: true, b: true });
});

test('debounce: deleting a key sends null (state.rs deletes on null)', async () => {
  const { store, b, timers } = make({ 'sessions.zoomOffset': 2 });
  await store.init();
  store.set('sessions.zoomOffset', undefined);
  assert.equal(store.get('sessions.zoomOffset'), undefined);
  timers.fire();
  await flushed();
  assert.deepEqual(b.patches, [{ 'sessions.zoomOffset': null }]);
  assert.equal('sessions.zoomOffset' in b.file, false);
});

test('flush: writes pending keys now and disarms the timer (pagehide path)', async () => {
  const { store, b, timers } = make();
  await store.init();
  store.set('split.width', 480);
  await store.flush();
  assert.deepEqual(b.patches, [{ 'split.width': 480 }]);
  assert.equal(timers.pending, false);
  await store.flush();
  assert.equal(b.patches.length, 1, 'nothing pending: no second patch');
});

test('flush: a refused patch is logged once and not retried', async () => {
  const { store, b, timers, logs } = make({}, { patchFails: true });
  await store.init();
  store.set('theme', 'zero');
  timers.fire();
  await flushed();
  assert.equal(b.patches.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(timers.pending, false, 'no retry armed');
});

test('size cap: a set that would reach MAX_STATE_BYTES is refused before any write', async () => {
  const { store, b, timers, logs } = make();
  await store.init();
  const ok = store.set('document.last', 'x'.repeat(MAX_STATE_BYTES));
  assert.equal(ok, false);
  assert.equal(store.get('document.last'), undefined);
  assert.equal(timers.pending, false);
  assert.equal(b.patches.length, 0);
  assert.match(logs[0], /document\.last/);
});

test('unreadable file: prefs run session-only and never patch', async () => {
  const { store, b, timers, logs } = make({}, { readFails: true });
  const legacy = legacyStore({ 'vidar-theme': 'panzer' });
  await store.init(legacy);
  assert.equal(store.get('theme'), 'panzer', 'old value still served this session');
  assert.equal(legacy.getItem('vidar-theme'), 'panzer', 'old copy kept: nothing durable took it');
  store.set('theme', 'zero');
  assert.equal(timers.pending, false);
  assert.equal(b.patches.length, 0);
  assert.equal(logs.length, 1);
});

test('import: dash and dotted keys land typed under their pref keys, then leave old storage', async () => {
  const { store, b } = make();
  const legacy = legacyStore({
    'vidar-theme': 'panzer',
    'vidar-rightbar': '300',
    'vidar-split': '512',
    'vidar-font': '16',
    'vidar-zoom-offset': '-2',
    'vidar.document.last': 'C:\\a.md',
    'vidar.document.groups': '{"x":true}',
    'vidar.order.rack': '["proxy","unreal"]',
    'vidar.order.loadout': '["a"]',
    'vidar.character.animationDropdown': 'off',
    'vidar.flow.graphs.v1': '{"v":1}',
    'vidar.flow.graphs.v1.bak-20260925': 'garbage',
    'someone-else': 'keep',
  });
  await store.init(legacy);
  assert.deepEqual(b.patches.length, 1, 'one patch for the whole import');
  assert.equal(store.get('theme'), 'panzer');
  assert.equal(store.get('rightbar.width'), 300);
  assert.equal(store.get('split.width'), 512);
  assert.equal(store.get('sessions.legacyFont'), 16);
  assert.equal(store.get('sessions.zoomOffset'), -2);
  assert.equal(store.get('document.last'), 'C:\\a.md');
  assert.deepEqual(store.get('document.groups'), { x: true });
  assert.deepEqual(store.get('order.rack'), ['proxy', 'unreal']);
  assert.deepEqual(store.get('order.loadout'), ['a']);
  assert.equal(store.get('character.animationDropdown'), 'off');
  assert.equal('flow.graphs.v1' in b.file, false, 'Flow graphs are not imported');
  assert.deepEqual(
    [...legacy._map.keys()].sort(),
    ['someone-else', 'vidar.flow.graphs.v1', 'vidar.flow.graphs.v1.bak-20260925'],
    'Flow keys and unrecognised keys stay untouched',
  );
  assert.equal(legacy.getItem('vidar.flow.graphs.v1'), '{"v":1}');
});

test('import: the file wins over an old copy of the same key', async () => {
  const { store } = make({ theme: 'zero' });
  const legacy = legacyStore({ 'vidar-theme': 'panzer' });
  await store.init(legacy);
  assert.equal(store.get('theme'), 'zero');
  assert.equal(legacy.getItem('vidar-theme'), null, 'recognised key removed anyway');
});

test('import: a failed patch keeps the old copies for the next boot', async () => {
  const { store, logs } = make({}, { patchFails: true });
  const legacy = legacyStore({ 'vidar-split': '400' });
  await store.init(legacy);
  assert.equal(legacy.getItem('vidar-split'), '400');
  assert.equal(logs.length, 1);
});

test('import: unparsable values are dropped, not imported', () => {
  const legacy = legacyStore({ 'vidar-rightbar': 'wide', 'vidar.order.rack': '{not json' });
  const { entries, sourceKeys } = collectLegacy(legacy, {});
  assert.deepEqual(entries, {});
  assert.deepEqual(sourceKeys.sort(), ['vidar-rightbar', 'vidar.order.rack']);
});

test('import: a second init with nothing left in old storage patches nothing', async () => {
  const { store, b } = make({ theme: 'zero' });
  await store.init(legacyStore());
  assert.equal(b.patches.length, 0);
});

test('import: an oversize import is skipped whole, old copies kept, later writes unaffected', async () => {
  const { store, b, timers, logs } = make();
  const legacy = legacyStore({ 'vidar.document.last': 'x'.repeat(MAX_STATE_BYTES), 'vidar-split': '400' });
  await store.init(legacy);
  assert.equal(b.patches.length, 0, 'nothing sent');
  assert.equal(store.get('document.last'), undefined, 'not in the cache');
  assert.equal(store.get('split.width'), undefined);
  assert.equal(legacy.getItem('vidar-split'), '400', 'old copies kept for a later boot');
  assert.match(logs[0], /import/);
  assert.equal(store.set('theme', 'zero'), true, 'fits() is not poisoned by the skipped import');
  timers.fire();
  await flushed();
  assert.deepEqual(b.patches, [{ theme: 'zero' }]);
});

test('import: a failed import patch leaves nothing in the cache (rolled back)', async () => {
  const { store, logs } = make({}, { patchFails: true });
  const legacy = legacyStore({ 'vidar.document.last': 'x'.repeat(MAX_STATE_BYTES - 1000), 'vidar-split': '400' });
  await store.init(legacy);
  assert.equal(store.get('document.last'), undefined);
  assert.equal(store.get('split.width'), undefined);
  assert.equal(legacy.getItem('vidar-split'), '400');
  assert.equal(logs.length, 1);
  assert.equal(store.set('document.last', 'y'.repeat(2000)), true, 'the failed import does not count against the cap');
});

test('size cap: matches state.rs, exactly MAX_STATE_BYTES is accepted, one more is refused', async () => {
  // {"document.last":"<n>"} serializes to n + 20 bytes.
  const { store } = make();
  await store.init();
  assert.equal(store.set('document.last', 'x'.repeat(MAX_STATE_BYTES - 19)), false);
  assert.equal(store.set('document.last', 'x'.repeat(MAX_STATE_BYTES - 20)), true);
});

test('non-object root: prefs run session-only and never patch', async () => {
  const { store, b, timers, logs } = make();
  b.read = async () => [1, 2];
  await store.init();
  store.set('theme', 'zero');
  assert.equal(store.get('theme'), 'zero');
  assert.equal(timers.pending, false);
  assert.equal(b.patches.length, 0);
  assert.match(logs[0], /not an object/);
});

test('flush errors: onError sees every failure, the log is once per key', async () => {
  const { store, b, timers, logs } = make({}, { patchFails: true });
  await store.init();
  const seen = [];
  store.onError((keys) => seen.push(keys));
  store.set('theme', 'zero');
  timers.fire();
  await flushed();
  store.set('theme', 'panzer');
  store.set('split.width', 400);
  timers.fire();
  await flushed();
  assert.deepEqual(seen, [['theme'], ['theme', 'split.width']]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /theme/);
  assert.doesNotMatch(logs[1], /theme/);
  assert.match(logs[1], /split\.width/);
  assert.equal(b.patches.length, 2, 'no retry');
});

// Review finding 3: a deferred backend that could settle out of order. Flush B must not be
// sent while A is outstanding, so B can never be applied before A.
test('flush order: write N+1 is sent only after write N settles', async () => {
  const file = {};
  const sent = [];
  const pending = [];
  const b = {
    read: async () => ({}),
    patch: (entries) => {
      sent.push(entries);
      return new Promise((resolve) => {
        pending.push(() => { Object.assign(file, entries); resolve(); });
      });
    },
  };
  const store = new PrefsStore(b, { timers: fakeTimers(), log: () => {} });
  await store.init();
  store.set('theme', 'A');
  const first = store.flush();
  store.set('theme', 'B');
  const second = store.flush();
  await flushed();
  assert.equal(sent.length, 1, 'B waits for A');
  let secondDone = false;
  second.then(() => { secondDone = true; });
  // Nothing new pending, but a third flush still waits for issued work.
  let idleDone = false;
  store.flush().then(() => { idleDone = true; });
  await flushed();
  assert.equal(idleDone, false, 'an empty flush waits for in-flight patches');
  pending.shift()();
  await first;
  await flushed();
  assert.equal(sent.length, 2, 'B sent once A settled');
  assert.equal(secondDone, false);
  pending.shift()();
  await second;
  await flushed();
  assert.equal(idleDone, true);
  assert.deepEqual(sent.map((e) => e.theme), ['A', 'B']);
  assert.equal(file.theme, 'B', 'last write wins on disk');
});

test('flush order: a flush during the init import is sent only after the import patch settles', async () => {
  const sent = [];
  const pending = [];
  const b = {
    read: async () => ({}),
    patch: (entries) => {
      sent.push(entries);
      return new Promise((resolve) => { pending.push(resolve); });
    },
  };
  const store = new PrefsStore(b, { timers: fakeTimers(), log: () => {} });
  const booted = store.init(legacyStore({ 'vidar-split': '400' }));
  await flushed();
  assert.equal(sent.length, 1, 'import patch issued');
  store.set('theme', 'A');
  const write = store.flush();
  await flushed();
  assert.equal(sent.length, 1, 'the flush waits for the import');
  pending.shift()();
  await booted;
  await flushed();
  assert.equal(sent.length, 2, 'sent once the import settled');
  pending.shift()();
  await write;
  assert.equal(sent[1].theme, 'A');
});

test('flush order: a failed write does not stall the ones after it', async () => {
  const { store, b } = make();
  await store.init();
  const realPatch = b.patch;
  let calls = 0;
  b.patch = async (entries) => {
    calls++;
    if (calls === 1) throw new Error('refused');
    return realPatch(entries);
  };
  store.set('theme', 'A');
  const first = store.flush();
  store.set('theme', 'B');
  await store.flush();
  await first;
  assert.equal(calls, 2);
  assert.equal(b.file.theme, 'B');
});

// Review finding 5: old browser storage that throws on access must not abort boot.
test('import: storage that throws on enumeration, getItem, and removeItem does not abort boot', async () => {
  const { store, logs } = make({ theme: 'zero' });
  let removed = false;
  const legacy = {
    get length() { throw new Error('SecurityError'); },
    key: () => { throw new Error('SecurityError'); },
    getItem: () => { throw new Error('SecurityError'); },
    removeItem: () => { removed = true; throw new Error('SecurityError'); },
  };
  await store.init(legacy);
  assert.equal(store.get('theme'), 'zero', 'hydrated file cache stands');
  assert.match(logs[0], /import skipped/);
  assert.equal(removed, false, 'legacy copies kept: removeItem never reached');
});

// Review finding 6: an unreadable file (or a non-object root) reaches the onError subscriber,
// even one that registers after init (main.ts subscribes after awaiting initPrefs).
test('init failure: onError hears it with no keys, replayed on late registration', async () => {
  const { store } = make({}, { readFails: true });
  const early = [];
  store.onError((keys, err) => early.push([keys, String(err)]));
  await store.init();
  assert.deepEqual(early, [[[], 'Error: parse error']]);
  const late = [];
  store.onError((keys) => late.push(keys));
  assert.deepEqual(late, [[]]);

  const { store: store2, b } = make();
  b.read = async () => [1];
  await store2.init();
  const seen = [];
  store2.onError((keys, err) => seen.push([keys, String(err)]));
  assert.equal(seen.length, 1);
  assert.match(seen[0][1], /not an object/);
});

test('init success: onError registration replays nothing', async () => {
  const { store } = make();
  await store.init();
  const seen = [];
  store.onError((keys) => seen.push(keys));
  assert.deepEqual(seen, []);
});

test('reading before init is logged once', () => {
  const { store, logs } = make();
  store.get('theme');
  store.get('theme');
  assert.equal(logs.length, 1);
});

test('confirmed saves remain pending and report ordered backend confirmations', async () => {
  const sent = [];
  const pending = [];
  const store = new PrefsStore({
    read: async () => ({}),
    patch: (entries) => {
      sent.push(entries);
      return new Promise((resolve) => pending.push(resolve));
    },
  }, { timers: fakeTimers(), log: () => {} });
  await store.init();
  let firstResult;
  let secondResult;
  const first = store.saveConfirmed('modules.hidden', ['bench:runes']).then((r) => { firstResult = r; return r; });
  const second = store.saveConfirmed('order.tools', ['marquee', 'eyedropper']).then((r) => { secondResult = r; return r; });
  assert.deepEqual(store.get('modules.hidden'), ['bench:runes'], 'accepted in memory');
  assert.equal(firstResult, undefined, 'not Saved before patch confirmation');
  await flushed();
  assert.deepEqual(sent, [{ 'modules.hidden': ['bench:runes'] }]);
  assert.equal(secondResult, undefined, 'second save waits for the first patch');
  pending.shift()();
  assert.deepEqual(await first, { status: 'saved', accepted: true });
  await flushed();
  assert.deepEqual(sent[1], { 'order.tools': ['marquee', 'eyedropper'] });
  assert.equal(secondResult, undefined);
  pending.shift()();
  assert.deepEqual(await second, { status: 'saved', accepted: true });
});

test('confirmed save reports a refused patch and preserves the existing error callback', async () => {
  const { store, b } = make({}, { patchFails: true });
  const errors = [];
  store.onError((keys, err) => errors.push([keys, String(err)]));
  await store.init();
  const result = await store.saveConfirmed('modules.hidden', ['bench:runes']);
  assert.deepEqual(result, { status: 'failed', accepted: true });
  assert.deepEqual(store.get('modules.hidden'), ['bench:runes'], 'session cache retains the edit');
  assert.equal(b.patches.length, 1);
  assert.deepEqual(errors, [[['modules.hidden'], 'Error: refused']]);
});

test('confirmed save reports session-only for unreadable state without claiming Saved', async () => {
  const { store, b } = make({}, { readFails: true });
  await store.init();
  const result = await store.saveConfirmed('modules.hidden', ['bench:lab']);
  assert.deepEqual(result, { status: 'session-only', accepted: true });
  assert.deepEqual(store.get('modules.hidden'), ['bench:lab']);
  assert.equal(b.patches.length, 0);
});

test('confirmed save never claims Saved after a local size refusal', async () => {
  const { store, b } = make();
  await store.init();
  const result = await store.saveConfirmed('modules.hidden', ['x'.repeat(MAX_STATE_BYTES)]);
  assert.deepEqual(result, { status: 'failed', accepted: false });
  assert.equal(store.get('modules.hidden'), undefined);
  assert.equal(b.patches.length, 0);
});

test('renamed module ids: a hidden Benchmark stays hidden as Lab and keeps its order slot', async () => {
  const { store, b } = make({
    'modules.hidden': ['bench:benchmark', 'bench:tray'],
    'order.workbenchTabs': ['doc', 'benchmark', 'flow'],
  });
  await store.init();
  assert.deepEqual(store.get('modules.hidden'), ['bench:lab', 'bench:tray']);
  assert.deepEqual(store.get('order.workbenchTabs'), ['doc', 'lab', 'flow']);
  assert.equal(b.patches.length, 0, 'the load itself writes nothing');
  await store.flush();
  assert.deepEqual(b.file['modules.hidden'], ['bench:lab', 'bench:tray']);
  assert.deepEqual(b.file['order.workbenchTabs'], ['doc', 'lab', 'flow']);
});

test('renamed module ids: both ids present collapse to one, first position kept', async () => {
  const { store, b } = make({
    'modules.hidden': ['bench:lab', 'bench:benchmark'],
    'order.workbenchTabs': ['benchmark', 'doc', 'lab'],
  });
  await store.init();
  assert.deepEqual(store.get('modules.hidden'), ['bench:lab']);
  assert.deepEqual(store.get('order.workbenchTabs'), ['lab', 'doc']);
  const fresh = make({ 'modules.hidden': ['bench:lab'] });
  await fresh.store.init();
  await fresh.store.flush();
  assert.equal(fresh.b.patches.length, 0, 'already-migrated lists are not rewritten');
  assert.equal(b.patches.length, 0);
});
