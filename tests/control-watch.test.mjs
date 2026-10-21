import test from 'node:test';
import assert from 'node:assert/strict';
import { waitVerdict, waitStep } from '../src/control/watch.ts';

test('ctl.wait verdict: absent or chip "dead" -> dead, "" or working -> running, idle -> done', () => {
  const snap = {
    tabs: [
      { id: 'blank', body: 'rendered', state: '' },
      { id: 'busy', body: 'rendered', state: 'working' },
      { id: 'ask', body: 'rendered', state: 'approval' },
      { id: 'idle', body: 'rendered', state: 'idle' },
      { id: 'stopped', body: 'rendered', state: 'dead' },
    ],
  };
  assert.equal(waitVerdict(snap, 'gone'), 'dead');
  assert.equal(waitVerdict(snap, 'stopped'), 'dead');
  assert.equal(waitVerdict(snap, 'blank'), 'running');
  assert.equal(waitVerdict(snap, 'busy'), 'running');
  assert.equal(waitVerdict(snap, 'ask'), 'running');
  assert.equal(waitVerdict(snap, 'idle'), 'done');
});

test('ctl.wait step: idle before the turn starts is not done; idle throughout is done only after grace', () => {
  const at = (state) => ({ tabs: [{ id: 'x', body: 'rendered', state }] });
  const grace = 10_000;

  // prompt X; wait X on a Falcon-hosted tab: idle first, then busy, then idle.
  const p = { startedAt: 0, seenBusy: false };
  assert.equal(waitStep(p, at('idle'), 'x', 0, grace), 'running');
  assert.equal(waitStep(p, at(''), 'x', 750, grace), 'running'); // unstamped chip is not busy
  assert.equal(p.seenBusy, false);
  assert.equal(waitStep(p, at('working'), 'x', 1_500, grace), 'running');
  assert.equal(waitStep(p, at('idle'), 'x', 2_250, grace), 'done');

  // Already-idle tab, no turn coming: done once grace has passed, not before.
  const q = { startedAt: 0, seenBusy: false };
  assert.equal(waitStep(q, at('idle'), 'x', 0, grace), 'running');
  assert.equal(waitStep(q, at('idle'), 'x', grace - 1, grace), 'running');
  assert.equal(waitStep(q, at('idle'), 'x', grace, grace), 'done');
});
