// src/lab/chart.ts: which runs join the comparable line, and x order by item commit, not date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSeries, isComparable, linePath } from '../src/lab/chart.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/lab/history-row.json', import.meta.url), 'utf8'));
const ok = { partial: false, dry: false, isolation: 'ok', comparable: true };
const row = (runId, itemCommit, delta, over = {}, startedAt = '2026-10-01T00:00:00Z') =>
  ({ ...fixture, ...ok, runId, itemCommit, startedAt, scores: { with: 1, without: 1 - delta, delta }, ...over });

test('partial, dry and not-comparable runs never join the comparable series', () => {
  const runs = [
    row('a', 'c1', 0.5),
    row('b', 'c2', 0.9, { partial: true }),
    row('c', 'c3', 0.8, { dry: true }),
    row('d', 'c4', 0.7, { isolation: 'unverified', comparable: false }),
    row('e', 'c5', 0.6, { isolation: 'failed', comparable: false }),
    row('f', 'c6', 0.4, { comparable: false }),
    row('g', 'c7', 0.2),
  ];
  const s = buildSeries(runs);
  assert.deepEqual(s.line, [{ x: 0, delta: 0.5 }, { x: 6, delta: 0.2 }]);
  assert.deepEqual(s.points.filter((p) => p.comparable).map((p) => p.runId), ['a', 'g']);
  assert.deepEqual(s.points.filter((p) => !p.comparable).map((p) => p.runId), ['b', 'c', 'd', 'e', 'f']);
  assert.equal(isComparable(fixture), false); // the fixture row is partial and unverified
  const d = linePath(s, { width: 320, height: 120, pad: 12 });
  assert.equal(d.split(/[ML]/).filter(Boolean).length, 2, 'the line has only the two comparable vertices');
});

test('points are ordered by item commit in history order, not by date', () => {
  const runs = [
    row('r1', 'old', 0.1, {}, '2026-10-05T00:00:00Z'),
    row('r2', 'new', 0.3, {}, '2026-10-01T00:00:00Z'),
    row('r3', 'old', 0.5, {}, '2026-09-01T00:00:00Z'),
    row('r4', null, 0.0, { partial: true }, '2026-08-01T00:00:00Z'),
  ];
  const s = buildSeries(runs);
  assert.deepEqual(s.commits, ['old', 'new', null]);
  assert.deepEqual(s.points.map((p) => [p.runId, p.x]), [['r1', 0], ['r2', 1], ['r3', 0], ['r4', 2]]);
  assert.deepEqual(s.line, [{ x: 0, delta: 0.3 }, { x: 1, delta: 0.3 }]); // commit "old" averages its two runs
});

test('a run with no delta takes a commit slot but no point', () => {
  const s = buildSeries([row('x', 'c1', 0.5, { scores: { with: null, without: null, delta: null } }), row('y', 'c2', 0.1)]);
  assert.deepEqual(s.commits, ['c1', 'c2']);
  assert.deepEqual(s.points.map((p) => p.runId), ['y']);
});
