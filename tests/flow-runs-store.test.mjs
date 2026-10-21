import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evict,
  reconcileInterrupted,
  loadRunsEnvelope,
  saveRunsEnvelope,
  readRunsEnvelope,
  backupInvalidRunsEnvelope,
  RUNS_KEY,
  RUNS_CAP,
} from '../src/flow/runs-core.ts';

// Map-backed StorageLike stub — never touches window/localStorage (leaf-module rule, §7).
function mapStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

const GRAPH = { id: 'g1', name: 'g', nodes: [], edges: [], updatedAt: '2026-09-25T00:00:00.000Z' };

function makeRun(id, startedAt, status, nodes = {}) {
  return {
    id,
    graphId: 'g1',
    graphSnapshot: GRAPH,
    status,
    startedAt,
    nodes,
  };
}

test('runs envelope round-trips through a Map stub', () => {
  const storage = mapStorage();
  const run = makeRun('r1', '2026-09-25T00:00:00.000Z', 'success');
  saveRunsEnvelope(storage, { v: 1, runs: [run] });
  assert.deepEqual(loadRunsEnvelope(storage), { v: 1, runs: [run] });
});

test('readRunsEnvelope tells absent apart from invalid, and RUNS_KEY is the frozen §4.1 key', () => {
  assert.equal(RUNS_KEY, 'vidar.flow.runs.v1');
  const storage = mapStorage();
  assert.deepEqual(readRunsEnvelope(storage), { status: 'absent', raw: null, env: null });

  storage.setItem(RUNS_KEY, 'not json');
  const invalid = readRunsEnvelope(storage);
  assert.equal(invalid.status, 'invalid');
  backupInvalidRunsEnvelope(storage, invalid.raw, '2026-09-25T01:02:03.000Z');
  assert.equal(storage._map.has('vidar.flow.runs.v1.bak-2026-09-25T01-02-03-000Z'), true);
});


test('evict: leaves the list alone at or under the cap', () => {
  const runs = [makeRun('r1', '2026-09-25T00:00:00.000Z', 'success')];
  assert.equal(evict(runs, RUNS_CAP), runs);
});

test('evict: drops the oldest completed run first once over cap', () => {
  const runs = [
    makeRun('old', '2026-09-25T00:00:00.000Z', 'success'),
    makeRun('mid', '2026-09-25T01:00:00.000Z', 'success'),
    makeRun('new', '2026-09-25T02:00:00.000Z', 'success'),
  ];
  const kept = evict(runs, 2);
  assert.deepEqual(kept.map((r) => r.id), ['mid', 'new']);
});

test('evict: never drops a run still status:"running", even when it is the oldest record', () => {
  const runs = [
    makeRun('oldest-running', '2026-09-25T00:00:00.000Z', 'running'),
    makeRun('mid', '2026-09-25T01:00:00.000Z', 'success'),
    makeRun('new', '2026-09-25T02:00:00.000Z', 'success'),
  ];
  const kept = evict(runs, 2);
  // over-cap by one, but the oldest record is "running" and must survive — the next-oldest
  // completed run is dropped instead.
  assert.deepEqual(
    kept.map((r) => r.id).sort(),
    ['new', 'oldest-running'].sort(),
  );
});

test('reconcileInterrupted: an unheld "running" run becomes "error" and its live nodes become canceled/"Interrupted"', () => {
  const runs = [
    makeRun('orphaned', '2026-09-25T00:00:00.000Z', 'running', {
      n1: { nodeId: 'n1', status: 'ok', attempts: 1 },
      n2: { nodeId: 'n2', status: 'running', attempts: 1 },
      n3: { nodeId: 'n3', status: 'queued', attempts: 1 },
      n4: { nodeId: 'n4', status: 'awaiting-approval', attempts: 1 },
    }),
  ];
  const { runs: out, reconciledRunIds } = reconcileInterrupted(runs, new Set(), '2026-09-25T03:00:00.000Z');
  assert.deepEqual(reconciledRunIds, ['orphaned']);
  const run = out[0];
  assert.equal(run.status, 'error');
  assert.equal(run.endedAt, '2026-09-25T03:00:00.000Z');
  assert.equal(run.nodes.n1.status, 'ok'); // already terminal, untouched
  assert.equal(run.nodes.n1.error, undefined);
  for (const id of ['n2', 'n3', 'n4']) {
    assert.equal(run.nodes[id].status, 'canceled');
    assert.equal(run.nodes[id].error, 'Interrupted');
    assert.equal(run.nodes[id].endedAt, '2026-09-25T03:00:00.000Z');
  }
});

test('reconcileInterrupted: a "running" run the engine still holds is left alone', () => {
  const runs = [makeRun('live', '2026-09-25T00:00:00.000Z', 'running', {
    n1: { nodeId: 'n1', status: 'running', attempts: 1 },
  })];
  const { runs: out, reconciledRunIds } = reconcileInterrupted(runs, new Set(['live']), '2026-09-25T03:00:00.000Z');
  assert.deepEqual(reconciledRunIds, []);
  assert.deepEqual(out, runs);
});

test('reconcileInterrupted: leaves already-finished runs alone regardless of heldRunIds', () => {
  const runs = [
    makeRun('done', '2026-09-25T00:00:00.000Z', 'success', { n1: { nodeId: 'n1', status: 'ok', attempts: 1 } }),
    makeRun('failed', '2026-09-25T00:00:00.000Z', 'error', { n1: { nodeId: 'n1', status: 'error', attempts: 1, error: 'boom' } }),
    makeRun('cancelled', '2026-09-25T00:00:00.000Z', 'canceled', { n1: { nodeId: 'n1', status: 'canceled', attempts: 1 } }),
  ];
  const { runs: out, reconciledRunIds } = reconcileInterrupted(runs, new Set(), '2026-09-25T03:00:00.000Z');
  assert.deepEqual(reconciledRunIds, []);
  assert.deepEqual(out, runs);
});

test('reconcileInterrupted: does not overwrite an already-set endedAt on the run or a node', () => {
  const runs = [
    makeRun('weird', '2026-09-25T00:00:00.000Z', 'running', {
      n1: { nodeId: 'n1', status: 'running', attempts: 1, endedAt: '2026-09-25T00:30:00.000Z' },
    }),
  ];
  runs[0].endedAt = '2026-09-25T00:45:00.000Z';
  const { runs: out } = reconcileInterrupted(runs, new Set(), '2026-09-25T03:00:00.000Z');
  assert.equal(out[0].endedAt, '2026-09-25T00:45:00.000Z');
  assert.equal(out[0].nodes.n1.endedAt, '2026-09-25T00:30:00.000Z');
});
