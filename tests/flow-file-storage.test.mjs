// The Flow file-store leaf against a scripted
// backend. Each write call is held until the test settles it, so ordering is observable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FileStorage, MAX_VALUE_BYTES } from '../src/flow/file-storage-core.ts';
import {
  readGraphsEnvelope, backupInvalidEnvelope, seedGraphsIfAbsent, saveGraphsEnvelope, readTemplatesEnvelope,
  seedTemplatesIfAbsent, reseedStarters, STARTERS_REV, GRAPHS_KEY, TEMPLATES_KEY,
} from '../src/flow/store-core.ts';
import { STARTER_TEMPLATES } from '../src/flow/templates.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

// Rest args, not a default: `undefined` is a reply under test.
function backend(...args) {
  const openReply = args.length ? args[0] : { writable: true, entries: {}, page: 1, seq: 0 };
  const calls = [];
  return {
    calls,
    open: async () => {
      if (openReply instanceof Error) throw openReply;
      return openReply;
    },
    write(page, seq, entries) {
      return new Promise((resolve, reject) => calls.push({ page, seq, entries, resolve, reject }));
    },
  };
}

async function opened(...args) {
  const b = backend(...args);
  const s = new FileStorage(b);
  await s.init();
  return { b, s };
}

// Nothing reads or writes before init; after it, a bad key or an oversize value
// throws at the call, never reaching the pump.
test('accessors throw before init, guards throw synchronously after', async () => {
  const b = backend({ writable: true, entries: { 'vidar.flow.graphs.v1': 'g' }, page: 1, seq: 0 });
  const s = new FileStorage(b);
  assert.throws(() => s.getItem('vidar.flow.graphs.v1'), /before init/);
  assert.throws(() => s.setItem('vidar.flow.graphs.v1', 'x'), /before init/);
  assert.throws(() => s.removeItem('vidar.flow.graphs.v1'), /before init/);
  await s.init();
  assert.equal(s.getItem('vidar.flow.graphs.v1'), 'g');
  assert.throws(() => s.setItem('vidar.flow..\\x', 'v'), /not a valid file key/);
  assert.throws(() => s.setItem('vidar.flow.big', 'x'.repeat(MAX_VALUE_BYTES + 1)), /16 MiB/);
  await tick();
  assert.equal(b.calls.length, 0);
});

// One batch per burst in first-dirtied order with the latest value; the next batch
// waits for the previous; flush sends at once and carries the in-flight keys.
test('coalescing, serialized batches, flush carries in-flight keys', async () => {
  const { b, s } = await opened();
  s.setItem('vidar.flow.a', '1');
  s.setItem('vidar.flow.b', '1');
  s.setItem('vidar.flow.a', '2');
  await tick();
  assert.equal(b.calls.length, 1);
  assert.deepEqual(b.calls[0].entries, [['vidar.flow.a', '2'], ['vidar.flow.b', '1']]);
  s.removeItem('vidar.flow.b');
  await tick();
  assert.equal(b.calls.length, 1, 'waits for the in-flight batch');
  const flushed = s.flush();
  await tick();
  assert.equal(b.calls.length, 2, 'flush does not wait');
  assert.deepEqual(b.calls[1].entries, [['vidar.flow.a', '2'], ['vidar.flow.b', null]]);
  assert.ok(b.calls[1].seq > b.calls[0].seq);
  b.calls[1].resolve(true);
  b.calls[0].resolve(false); // the stale one, ignored by Rust
  assert.equal(await flushed, true);
});

// Reload race: batches number on from the seq the open returned and carry its page id,
// so Rust can judge staleness per page and a reload never restarts at 1.
test('batches number from the open reply seq and carry its page', async () => {
  const { b, s } = await opened({ writable: true, entries: {}, page: 7, seq: 41 });
  s.setItem('vidar.flow.a', '1');
  await tick();
  assert.deepEqual([b.calls[0].page, b.calls[0].seq], [7, 42]);
});

// A failed batch goes back ahead of keys dirtied since, in its own order, and is sent on
// the next write (no timer), so a backup never lands after the overwrite it protects.
test('resend after a failure keeps the order across the failed batch', async () => {
  const { b, s } = await opened();
  const errors = [];
  s.onError((kind, keys) => errors.push([kind, keys]));
  s.setItem('vidar.flow.graphs.v1.bak-1', 'old');
  s.setItem('vidar.flow.graphs.v1', 'new');
  await tick();
  s.setItem('vidar.flow.runs.v1', 'r');
  s.setItem('vidar.flow.graphs.v1', 'newer');
  b.calls[0].reject(new Error('disk full'));
  await tick();
  assert.deepEqual(errors, [['save', ['vidar.flow.graphs.v1.bak-1', 'vidar.flow.graphs.v1']]]);
  assert.equal(b.calls.length, 1, 'no automatic retry');
  s.setItem('vidar.flow.x', '1');
  await tick();
  assert.deepEqual(b.calls[1].entries.map(([k]) => k), [
    'vidar.flow.graphs.v1.bak-1', 'vidar.flow.graphs.v1', 'vidar.flow.runs.v1', 'vidar.flow.x',
  ]);
  assert.equal(b.calls[1].entries[1][1], 'newer');
  // A key the Rust side rejected by name is dropped, not retried.
  b.calls[1].reject(new Error('rejected vidar.flow.x: invalid key'));
  await tick();
  const ok = s.flush();
  await tick();
  assert.deepEqual(b.calls[2].entries.map(([k]) => k), ['vidar.flow.graphs.v1.bak-1', 'vidar.flow.graphs.v1', 'vidar.flow.runs.v1']);
  b.calls[2].resolve(true);
  assert.equal(await ok, true);
});

// Read-only (locked) or unreadable storage serves what it read, throws on every write,
// never sends, stays read-only for the page's life, and replays its error to a late subscriber.
test('read-only and unreadable storage never write; the error replays', async () => {
  for (const [reply, kind] of [
    [{ writable: false, entries: { 'vidar.flow.graphs.v1': 'g' }, page: 1, seq: 0, lockError: null }, 'locked'],
    [{ writable: false, entries: { 'vidar.flow.graphs.v1': 'g' }, page: 1, seq: 0, lockError: "can't open writer.lock: denied" }, 'lockfailed'],
    [new Error('state\\flow\\vidar.flow.graphs.v1.json: invalid UTF-8'), 'unreadable'],
    [undefined, 'unreadable'], // a reply with no object
    [{ writable: true, entries: {} }, 'unreadable'], // no page/seq: numbering unknown, never write
  ]) {
    const { b, s } = await opened(reply);
    assert.equal(s.getItem('vidar.flow.graphs.v1'), kind === 'locked' || kind === 'lockfailed' ? 'g' : null);
    assert.throws(() => s.setItem('vidar.flow.graphs.v1', 'x'), /read-only/);
    assert.throws(() => s.removeItem('vidar.flow.graphs.v1'), /read-only/);
    await s.init();
    assert.equal(s.writable, false);
    assert.equal(await s.flush(), false);
    const seen = [];
    s.onError((k) => seen.push(k));
    assert.deepEqual(seen, [kind]);
    assert.equal(b.calls.length, 0);
  }
});

// A read-only store still mounts Flow. store.ts's initStore imports the app (ipc), so
// this replays its store-core sequence against a locked store whose every branch wants to write
// (invalid graphs envelope to back up, starters rev behind).
test('read-only store: the initStore sequence does not throw', async () => {
  const { s } = await opened({
    writable: false, page: 1, seq: 0, lockError: null,
    entries: { [GRAPHS_KEY]: '{not json', 'vidar.flow.startersRev': '1', [TEMPLATES_KEY]: JSON.stringify({ v: 1, templates: [] }) },
  });
  const now = '2026-09-27T00:00:00.000Z';
  assert.doesNotThrow(() => {
    const g = readGraphsEnvelope(s);
    assert.equal(g.status, 'invalid');
    assert.equal(backupInvalidEnvelope(s, GRAPHS_KEY, g.raw, now), false);
    assert.equal(saveGraphsEnvelope(s, seedGraphsIfAbsent(s, now)), false);
    const t = readTemplatesEnvelope(s);
    const templates = t.status === 'ok' ? t.env.templates : seedTemplatesIfAbsent(s, STARTER_TEMPLATES);
    assert.equal(reseedStarters(s, templates, STARTER_TEMPLATES, STARTERS_REV).length, STARTER_TEMPLATES.length);
  });
  assert.equal(s.getItem(GRAPHS_KEY), '{not json', 'nothing overwritten');
});

test('a failed graph commit restores the mirror and pending write, then retry lands', async () => {
  const { b, s } = await opened({ writable: true, entries: { [GRAPHS_KEY]: 'old' }, page: 1, seq: 0 });
  const previous = s.captureKey(GRAPHS_KEY);
  s.setItem(GRAPHS_KEY, 'unapproved');
  const failed = s.flush();
  await tick();
  b.calls[0].reject(new Error('disk full'));
  assert.equal(await failed, false);
  s.restoreKey(GRAPHS_KEY, previous);
  assert.equal(s.getItem(GRAPHS_KEY), 'old');
  assert.equal(s.captureKey(GRAPHS_KEY).dirty, false);
  s.setItem(GRAPHS_KEY, 'approved');
  const retry = s.flush();
  await tick();
  assert.deepEqual(b.calls[1].entries, [[GRAPHS_KEY, 'approved']]);
  b.calls[1].resolve(true);
  assert.equal(await retry, true);
});
