import test from 'node:test';
import assert from 'node:assert/strict';
import { autoLayout } from '../src/flow/layout.ts';
import { STARTER_TEMPLATES } from '../src/flow/templates.ts';

const W = 240;
const node = (id, h = 48) => ({ id, w: W, h });
const chain = (ids) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));
const centre = (L, id) => L[id].x + W / 2;

function assertNoOverlap(nodes, L) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const pa = L[a.id], pb = L[b.id];
      const apart = pa.x + a.w <= pb.x || pb.x + b.w <= pa.x || pa.y + a.h <= pb.y || pb.y + b.h <= pa.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
  }
}

test('autoLayout: a chain sits on one spine, top to bottom, on the grid', () => {
  const nodes = [node('input', 40), node('a', 60), node('b', 48), node('output', 32)];
  const L = autoLayout(nodes, chain(['input', 'a', 'b', 'output']), { axisX: 120, top: 48 });
  for (const n of nodes) {
    assert.equal(centre(L, n.id), 120, `${n.id} on the spine`);
    assert.equal(L[n.id].x % 16, 0);
    assert.equal(L[n.id].y % 16, 0);
  }
  assert.equal(L.input.y, 48);
  // row gap: tallest card in the row + 48, rounded up to 16
  assert.equal(L.a.y, Math.ceil((48 + 40 + 48) / 16) * 16);
  assert.ok(L.a.y < L.b.y && L.b.y < L.output.y);
  assertNoOverlap(nodes, L);
});

test('autoLayout: fan-out spreads children symmetrically under the parent', () => {
  const nodes = [node('p'), node('c1'), node('c2'), node('c3')];
  const edges = [{ from: 'p', to: 'c1' }, { from: 'p', to: 'c2' }, { from: 'p', to: 'c3' }];
  const L = autoLayout(nodes, edges, { axisX: 520 });
  const pc = centre(L, 'p');
  assert.equal(centre(L, 'c2'), pc, 'middle child straight under');
  assert.equal(pc - centre(L, 'c1'), centre(L, 'c3') - pc, 'outer children symmetric');
  assert.ok(centre(L, 'c1') < centre(L, 'c3'), 'document order: first sibling left');
  assertNoOverlap(nodes, L);
});

test('autoLayout: fan-out of two is symmetric, fan-in lands centred between its parents', () => {
  const nodes = [node('input'), node('p'), node('a', 64), node('b', 96), node('output')];
  const edges = [...chain(['input', 'p', 'a', 'output']), { from: 'p', to: 'b' }, { from: 'b', to: 'output' }];
  const L = autoLayout(nodes, edges, { axisX: 520 });
  const pc = centre(L, 'p');
  assert.equal(pc - centre(L, 'a'), centre(L, 'b') - pc);
  assert.equal(centre(L, 'output'), (centre(L, 'a') + centre(L, 'b')) / 2);
  assert.equal(centre(L, 'output'), pc, 'fan-in back on the spine');
  assert.equal(L.a.y, L.b.y, 'siblings share a row');
  assert.ok(L.output.y >= L.b.y + 96 + 48, 'row below the tallest card keeps the gap');
  assertNoOverlap(nodes, L);
});

test('autoLayout: a cycle terminates and still places every node without overlap', () => {
  const nodes = [node('a'), node('b'), node('c')];
  const edges = [...chain(['a', 'b', 'c']), { from: 'c', to: 'a' }, { from: 'b', to: 'b' }, { from: 'x', to: 'a' }];
  const L = autoLayout(nodes, edges);
  assert.deepEqual(Object.keys(L).sort(), ['a', 'b', 'c']);
  assertNoOverlap(nodes, L);
});

test('autoLayout: disconnected sources in one row do not overlap', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  const L = autoLayout(nodes, [{ from: 'a', to: 'd' }]);
  assertNoOverlap(nodes, L);
  assert.equal(L.a.y, L.b.y);
});

test('autoLayout: empty graph returns nothing', () => {
  assert.deepEqual(autoLayout([], []), {});
});

test('starter templates: top-to-bottom, no overlapping cards at generous nominal heights', () => {
  // generous: an agent card with a subtitle, a field and one addon row is ~86px
  const NOMINAL_H = { input: 64, agent: 90, output: 40 };
  for (const t of STARTER_TEMPLATES) {
    const nodes = t.graph.nodes.map((n) => ({ id: n.id, w: W, h: NOMINAL_H[n.kind] }));
    const L = Object.fromEntries(t.graph.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    assertNoOverlap(nodes, L);
    for (const e of t.graph.edges) {
      assert.ok(L[e.to.node].y > L[e.from.node].y, `${t.id}: ${e.from.node} -> ${e.to.node} runs downward`);
    }
  }
});
