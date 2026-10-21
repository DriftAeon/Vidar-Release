import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteGraphFromEnvelope, loadGraphsEnvelope, normalizeGraphsEnvelope, saveGraphsEnvelope, stampGraph } from '../src/flow/store-core.ts';
import { STARTER_TEMPLATES } from '../src/flow/templates.ts';

const g = (id, updatedAt) => stampGraph({ id, name: id, nodes: [], edges: [], updatedAt }, updatedAt);
const env = (activeGraphId, graphs) => ({ v: 1, activeGraphId, graphs });
const PROTECTED = STARTER_TEMPLATES.map((t) => t.id);

test('deleting a user graph removes only that entry and keeps the active graph', () => {
  const a = g('a', '2026-10-01T00:00:00.000Z');
  const b = g('b', '2026-10-02T00:00:00.000Z');
  const res = deleteGraphFromEnvelope(env('a', [a, b]), 'b', PROTECTED);
  assert.equal(res.ok, true);
  assert.deepEqual(res.env.graphs.map((x) => x.id), ['a']);
  assert.equal(res.env.activeGraphId, 'a');
  assert.equal(res.activeChanged, false);
});

test('a template or starter id is refused, even when a graph carries it', () => {
  const starterId = STARTER_TEMPLATES[0].id;
  const clash = g(starterId, '2026-10-01T00:00:00.000Z');
  const before = env(starterId, [clash]);
  const res = deleteGraphFromEnvelope(before, starterId, PROTECTED);
  assert.deepEqual(res, { ok: false, reason: 'protected' });
  assert.equal(before.graphs.length, 1);
  const custom = deleteGraphFromEnvelope(env(null, [g('x', '2026-10-01T00:00:00.000Z')]), 'tpl-mine', ['tpl-mine']);
  assert.deepEqual(custom, { ok: false, reason: 'protected' });
});

test('an id the list does not hold is refused', () => {
  const res = deleteGraphFromEnvelope(env('a', [g('a', '2026-10-01T00:00:00.000Z')]), 'nope', PROTECTED);
  assert.deepEqual(res, { ok: false, reason: 'missing' });
});

test('deleting the active graph leaves none selected, survivors kept', () => {
  const old = g('old', '2026-10-01T00:00:00.000Z');
  const newest = g('newest', '2026-10-05T00:00:00.000Z');
  const active = g('active', '2026-10-09T00:00:00.000Z');
  const res = deleteGraphFromEnvelope(env('active', [old, active, newest]), 'active', PROTECTED);
  assert.equal(res.ok, true);
  assert.equal(res.activeChanged, true);
  assert.equal(res.env.activeGraphId, null);
  assert.deepEqual(res.env.graphs.map((x) => x.id), ['old', 'newest']);
});

test('a null active id round-trips through the envelope and survives load normalisation', () => {
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
  const res = deleteGraphFromEnvelope(env('a', [g('a', '2026-10-01T00:00:00.000Z'), g('b', '2026-10-02T00:00:00.000Z')]), 'a', PROTECTED);
  assert.equal(saveGraphsEnvelope(storage, res.env), true);
  const loaded = loadGraphsEnvelope(storage);
  assert.equal(loaded.activeGraphId, null);
  const normalized = normalizeGraphsEnvelope(loaded, '2026-10-03T00:00:00.000Z');
  assert.equal(normalized.activeGraphId, null);
  assert.deepEqual(normalized.graphs.map((x) => x.id), ['b']);
});

test('deleting the last graph leaves no active graph', () => {
  const res = deleteGraphFromEnvelope(env('only', [g('only', '2026-10-01T00:00:00.000Z')]), 'only', PROTECTED);
  assert.equal(res.ok, true);
  assert.equal(res.activeChanged, true);
  assert.equal(res.env.activeGraphId, null);
  assert.deepEqual(res.env.graphs, []);
});
