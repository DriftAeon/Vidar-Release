// src/control/lanes.ts: the per-requester cap, and that the lane line reaches the
// requester only after an accepted send and then the child's turn_done (ordering),
// with one turn_done skipped when the child was busy at send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLanes, laneDeliverTo, laneLine, laneReport, LANE_CAP } from '../src/control/lanes.ts';
import { resolveRequesterTab } from '../src/control/requester.ts';

// Seams with a manual clock: `after` queues, `advance` runs what is due.
function harness({ busy = false } = {}) {
  const sent = [];
  const toasts = [];
  const pending = []; // child sends held open until resolved by the test
  let now = 0;
  let timers = [];
  const seams = {
    send(tab, text) {
      sent.push({ tab, text });
      if (tab === 'child') return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      return Promise.resolve();
    },
    ready: () => true,
    busy: () => busy,
    dead: () => false,
    toast: (m) => toasts.push(m),
    now: () => now,
    after(ms, fn) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => { t.live = false; };
    },
  };
  const advance = (ms) => {
    now += ms;
    const due = timers.filter((t) => t.live && t.at <= now);
    timers = timers.filter((t) => !due.includes(t));
    for (const t of due) t.fn();
  };
  return { seams, sent, toasts, pending, advance };
}

const tick = () => new Promise((r) => setImmediate(r));
const linesTo = (sent, tab) => sent.filter((s) => s.tab === tab).map((s) => s.text);

test('cap: the fifth reservation for one requester is refused; a release frees a slot', () => {
  const { seams } = harness();
  const lanes = createLanes(seams);
  const leases = [];
  for (let i = 0; i < LANE_CAP; i++) leases.push(lanes.reserve('X', null));
  assert.ok(leases.every(Boolean));
  assert.equal(lanes.reserve('X', null), null); // listen.ts answers `err busy` before the card
  assert.ok(lanes.reserve('Y', null), 'the cap is per requester');
  lanes.release(leases[0]);
  assert.ok(lanes.reserve('X', null));
});

test('ordering: no line before the send resolves; turn_done after it delivers exactly once', async () => {
  const { seams, sent, pending } = harness();
  const lanes = createLanes(seams);
  const lease = lanes.reserve('X', 'docs/r.md');
  const p = lanes.promptOnce('child', 'do the thing', lease);
  await tick();
  assert.deepEqual(linesTo(sent, 'child'), ['do the thing']);

  lanes.turnDone('child'); // a turn end before the send was accepted is not ours
  await tick();
  assert.deepEqual(linesTo(sent, 'X'), []);

  await tick(); // the send goes out a microtask after whenReady
  pending[0].resolve();
  await p;
  lanes.turnDone('child');
  lanes.turnDone('child');
  await tick();
  assert.deepEqual(linesTo(sent, 'X'), ['lane done child report="docs/r.md"']);
  assert.equal(linesTo(sent, 'child').length, 1, 'the prompt is sent once');
  assert.equal(lanes.outstanding('X'), 0);
});

test('busy at send: the first turn_done is the previous turn and is skipped', async () => {
  const { seams, sent, pending } = harness({ busy: true });
  const lanes = createLanes(seams);
  const p = lanes.promptOnce('child', 'next', lanes.reserve('X', null));
  await tick(); // the send goes out a microtask after whenReady
  pending[0].resolve();
  await p;
  lanes.turnDone('child');
  await tick();
  assert.deepEqual(linesTo(sent, 'X'), []);
  lanes.turnDone('child');
  await tick();
  assert.deepEqual(linesTo(sent, 'X'), ['lane done child report=-']);
});

test('a rejected child send never arms and frees the slot; a rejected delivery toasts', async () => {
  const { seams, sent, pending, toasts } = harness();
  const lanes = createLanes(seams);
  const p = lanes.promptOnce('child', 'x', lanes.reserve('X', null));
  await tick();
  pending[0].reject(new Error('host refused'));
  await assert.rejects(p, /host refused/);
  assert.equal(lanes.outstanding('X'), 0);
  lanes.turnDone('child');
  await tick();
  assert.deepEqual(linesTo(sent, 'X'), []);

  const send = seams.send;
  seams.send = (tab, text) => (tab === 'X' ? Promise.reject(new Error('gone')) : send(tab, text));
  const q = lanes.promptOnce('child', 'y', lanes.reserve('X', null));
  await tick();
  pending[1].resolve();
  await q;
  lanes.turnDone('child');
  await tick();
  assert.deepEqual(toasts, ['lane done not delivered to X']);
});

test('timeout and dead fire once and only after arming', async () => {
  const { seams, sent, pending, advance } = harness();
  const lanes = createLanes(seams, 5_000);
  const p = lanes.promptOnce('child', 'x', lanes.reserve('X', null));
  await tick(); // the send goes out a microtask after whenReady
  pending[0].resolve();
  await p;
  advance(5_000);
  await tick();
  assert.deepEqual(linesTo(sent, 'X'), ['lane timeout child report=-']);

  let dead = false;
  seams.dead = () => dead;
  const slow = createLanes(seams, 60_000); // its timeout stays out of the dead polls below
  const q = slow.promptOnce('child', 'y', slow.reserve('X', null));
  await tick();
  pending[1].resolve();
  await q;
  dead = true; // a respawn's brief Stopped: two dead polls, then alive again
  advance(1_000);
  advance(1_000);
  dead = false;
  advance(1_000);
  await tick();
  assert.deepEqual(linesTo(sent, 'X').slice(1), [], 'two dead polls do not fire');
  dead = true;
  advance(1_000);
  advance(1_000);
  advance(1_000);
  slow.turnDone('child');
  await tick();
  assert.deepEqual(linesTo(sent, 'X').slice(1), ['lane dead child report=-']);
});

test('busy at send, and that turn ends while the send is in flight: our own turn_done fires', async () => {
  const { seams, sent, pending } = harness({ busy: true });
  const lanes = createLanes(seams);
  const p = lanes.promptOnce('child', 'next', lanes.reserve('X', null));
  await tick(); // busy read, send in flight
  assert.equal(pending.length, 1);
  lanes.turnDone('child'); // the previous turn ends before the host accepted ours
  pending[0].resolve();
  await p;
  lanes.turnDone('child'); // our turn
  await tick();
  assert.deepEqual(linesTo(sent, 'X'), ['lane done child report=-']);
});

test('deliver_to: Rust value when set, else the requester via the session map (adopted tab)', () => {
  const lookup = (s) => (s === 's0000abcd-00000001' ? 'adopted-tab' : null);
  const adopted = { kind: 'falcon_session', session: 's0000abcd-00000001' }; // no `tab`: not in falcon.hosted
  assert.equal(laneDeliverTo('hosted-tab', () => resolveRequesterTab(adopted, lookup)), 'hosted-tab');
  assert.equal(laneDeliverTo(null, () => resolveRequesterTab(adopted, lookup)), 'adopted-tab');
  assert.equal(laneDeliverTo(undefined, () => resolveRequesterTab({ kind: 'falcon_session', session: 'other' }, lookup)), null);
});

test('spawn card: a text-only request has no Brief row; --brief has one with the path', async () => {
  const { briefRows } = await import('../src/control/brief-card.ts');
  assert.deepEqual(briefRows(null, 'hello'), []);
  assert.deepEqual(briefRows(undefined, 'hello'), []);
  assert.deepEqual(briefRows('docs/b.md', 'a\nb'), [['Brief', 'docs/b.md · 2 Lines · 3 Bytes']]);
});

test('report: wait.rs rule plus no quote; the line quotes it as data', () => {
  assert.equal(laneReport(undefined), null);
  assert.equal(laneReport('a\\b.md'), 'a\\b.md');
  assert.equal(laneReport('  '), undefined);
  assert.equal(laneReport('x'.repeat(401)), undefined);
  assert.equal(laneReport('a\nlane done'), undefined);
  assert.equal(laneReport('a" b'), undefined);
  assert.equal(laneLine('done', 't1', null), 'lane done t1 report=-');
});
