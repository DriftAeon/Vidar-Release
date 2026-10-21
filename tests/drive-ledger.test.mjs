import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { armsLedger, READ_ONLY_VERBS, liveLedger, writeLedger, clearLedger, spawnedHosted, hostedSessions, unresolvedHosted, ledgerFile, LEDGER_NAME, snapshotRecord, leftoverLocal, leftoverSessions, NO_FALCON_LIST } from '../tools/drive/drive-ledger.mjs';
import { LOCK_MS } from '../tools/drive/drive-budget.mjs';
import { rel } from '../tools/lib/paths.mjs';

const T0 = 1_000_000_000_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidar-drive-ledger-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('read-only verbs and the cleanup verbs never arm the ledger; spawning verbs do', () => {
  for (const v of [...READ_ONLY_VERBS, 'close-spawned', 'check-clean']) assert.equal(armsLedger(v), false, v);
  for (const v of ['open', 'send', 'answer', 'card', 'click', 'eval', 'invoke', 'shortcut', 'paste']) assert.equal(armsLedger(v), true, v);
});

test('the ledger sits in the driverMode folder of the paths contract', () => {
  const file = ledgerFile({ root: dir });
  assert.equal(path.basename(file), LEDGER_NAME);
  assert.equal(path.relative(dir, path.dirname(file)).split(path.sep).join('/'), rel('driverMode'));
});

test('a ledger binds until the budget lock lapses or a newer budget arming starts a new smoke', () => {
  const file = path.join(dir, 'sub', LEDGER_NAME);
  assert.equal(liveLedger(file, null, T0), null, 'absent: snapshot first');
  writeLedger(file, { sessions: ['t1', 't2'], unresolved: [], local: [], page: 1, falcon: [] }, T0);
  assert.deepEqual(liveLedger(file, null, T0 + 1000)?.sessions, ['t1', 't2']);
  assert.ok(liveLedger(file, { armedAt: T0 - 5 }, T0 + 1000), 'budget armed before the snapshot: same smoke');
  assert.equal(liveLedger(file, { armedAt: T0 + 10 }, T0 + 1000), null, 'budget re-armed after it: new smoke');
  assert.equal(liveLedger(file, null, T0 + LOCK_MS), null, 'older than the lock: stale');
  clearLedger(file);
  assert.equal(liveLedger(file, null, T0 + 1000), null, 'cleared: the run is over');
});

test('only hosted tabs whose Falcon session the ledger did not record count as spawned', () => {
  const before = { tabs: [{ id: 's1-aaa', hosted: true, falconSession: 'f-old' }, { id: 's2-aaa', hosted: false, falconSession: null }] };
  const ledger = { v: 2, at: T0, sessions: hostedSessions(before), unresolved: unresolvedHosted(before) };
  const state = {
    tabs: [
      { id: 's1-bbb', hosted: true, falconSession: 'f-old' }, // re-adopted after a reload: new tab id
      { id: 's3-bbb', hosted: true, falconSession: 'f-new' },
      { id: 's4-bbb', hosted: false, falconSession: null },
    ],
  };
  assert.deepEqual(spawnedHosted(ledger, state), { spawned: ['s3-bbb'], unresolved: [] });
});

test('a hosted tab with no Falcon session is reported unresolved, never clean', () => {
  const before = { tabs: [{ id: 's1-aaa', hosted: true, falconSession: null }] };
  const ledger = { v: 2, at: T0, sessions: hostedSessions(before), unresolved: unresolvedHosted(before) };
  const state = {
    tabs: [
      { id: 's1-aaa', hosted: true, falconSession: null }, // already unresolved at snapshot: not this smoke's
      { id: 's2-aaa', hosted: true, falconSession: null },
    ],
  };
  assert.deepEqual(spawnedHosted(ledger, state), { spawned: [], unresolved: ['s2-aaa'] });
});

const probe = (tabs, falcon, page = 100) => ({ state: { tabs }, page, falcon });
const fal = (sessions, held = []) => ({ sessions, held });
const snapOf = (p) => ({ ...snapshotRecord(p) });

test('a live v2 ledger upgrades with local, page and falcon null; a v3 one round-trips', () => {
  const file = path.join(dir, 'v2', LEDGER_NAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 2, at: T0, sessions: ['f1'], unresolved: ['s1-a'] }));
  assert.deepEqual(liveLedger(file, null, T0 + 1000), { v: 3, at: T0, sessions: ['f1'], unresolved: ['s1-a'], local: null, page: null, falcon: null });
  assert.equal(liveLedger(file, null, T0 + LOCK_MS), null, 'a stale v2 file still lapses');
  const snap = snapOf(probe([{ id: 's1-a', hosted: true, falconSession: 'f1' }, { id: 's2-a', hosted: false }], fal([{ session: 'f1', exited: null }, { session: 'f9', exited: 0 }])));
  writeLedger(file, snap, T0);
  assert.deepEqual(liveLedger(file, null, T0 + 1000), { v: 3, at: T0, sessions: ['f1'], unresolved: [], local: ['s2-a'], page: 100, falcon: ['f1'] });
});

test('local tabs: same page, the new ones are spawned; changed page or no snapshot, all unresolved', () => {
  const ledger = { sessions: [], unresolved: [], local: ['s1-a'], page: 100, falcon: [] };
  const tabs = [{ id: 's1-a', hosted: false }, { id: 's2-a', hosted: false }, { id: 's3-a', hosted: true, falconSession: 'f' }];
  assert.deepEqual(leftoverLocal(ledger, probe(tabs, null, 100)), { spawned: ['s2-a'], unresolved: [] });
  assert.deepEqual(leftoverLocal(ledger, probe(tabs, null, 200)), { spawned: [], unresolved: ['s1-a', 's2-a'] });
  assert.deepEqual(leftoverLocal({ ...ledger, local: null, page: null }, probe(tabs, null, 100)), { spawned: [], unresolved: ['s1-a', 's2-a'] });
});

test('a live session held by a tab is not a leftover', () => {
  const ledger = { sessions: [], unresolved: [], local: [], page: 1, falcon: [] };
  const p = probe([{ id: 's1-a', hosted: true, falconSession: 'f-tab' }], fal([{ session: 'f-tab', exited: null, attached: 1 }]));
  assert.deepEqual(leftoverSessions(ledger, p), { spawned: [], unresolved: [] });
});

test('a session in falcon_hosted_held, or one already exited, is not a leftover', () => {
  const ledger = { sessions: [], unresolved: [], local: [], page: 1, falcon: [] };
  const p = probe([], fal([{ session: 'f-held', exited: null }, { session: 'f-dead', exited: 0 }], [{ tab: 's9-a', session: 'f-held', gen: 3 }]));
  assert.deepEqual(leftoverSessions(ledger, p), { spawned: [], unresolved: [] });
});

test('a session the snapshot saw (falcon or tab sessions) is not a leftover', () => {
  const ledger = { sessions: ['f-a'], unresolved: [], local: [], page: 1, falcon: ['f-b'] };
  const p = probe([], fal([{ session: 'f-a', exited: null }, { session: 'f-b', exited: null }]));
  assert.deepEqual(leftoverSessions(ledger, p), { spawned: [], unresolved: [] });
});

test('a leftover is shell when the shell last held it or a client is attached, otherwise parked', () => {
  const ledger = { sessions: [], unresolved: [], local: [], page: 1, falcon: [] };
  const p = probe([], fal([
    { session: 'f-last', exited: null, attached: 0, last_holder: 'falcon-shell' },
    { session: 'f-att', exited: null, attached: 1, last_holder: null },
    { session: 'f-park', exited: null, attached: 0, last_holder: 'vidar' },
    { session: 'f-old', exited: null, attached: 0 },
  ]));
  assert.deepEqual(leftoverSessions(ledger, p).spawned, [
    { session: 'f-last', kind: 'shell' }, { session: 'f-att', kind: 'shell' },
    { session: 'f-park', kind: 'parked' }, { session: 'f-old', kind: 'parked' },
  ]);
});

test('a null falcon on either side is unresolved, never a pass', () => {
  const ok = { sessions: [], unresolved: [], local: [], page: 1, falcon: [] };
  const want = { spawned: [], unresolved: [NO_FALCON_LIST] };
  assert.deepEqual(leftoverSessions({ ...ok, falcon: null }, probe([], fal([]))), want);
  assert.deepEqual(leftoverSessions(ok, probe([], null)), want);
  assert.equal(snapshotRecord(probe([], null)).falcon, null);
});
