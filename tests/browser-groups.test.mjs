import test from 'node:test';
import assert from 'node:assert/strict';
import { groupItems, segments } from '../src/browser/groups.ts';

const it = (id, group) => ({ id, key: '', title: id, status: '', updated: '', group, facets: {}, fields: [] });
const g = (id, label, rank, tone = 'neutral') => ({ id, label, rank, tone });

test('bands order by rank, then label; rows keep input order', () => {
  const bands = groupItems([
    it('1', g('b', 'Beta', 1)),
    it('2', g('z', 'Zed', 0)),
    it('3', g('a', 'Alpha', 1)),
    it('4', g('z', 'Zed', 0)),
  ]);
  assert.deepEqual(bands.map((b) => b.label), ['Zed', 'Alpha', 'Beta']);
  assert.deepEqual(bands[0].items.map((i) => i.id), ['2', '4']);
});

test('items with no group share one band labelled empty', () => {
  const bands = groupItems([it('1'), it('2'), it('3', g('a', 'Alpha', 5))]);
  assert.deepEqual(bands.map((b) => b.label), ['Alpha', '']);
  assert.deepEqual(bands[1].items.map((i) => i.id), ['1', '2']);
  const flat = groupItems([it('1'), it('2')]);
  assert.equal(flat.length, 1);
  assert.equal(flat[0].label, '');
  assert.deepEqual(groupItems([]), []);
});

test('segments follow band order, count from the shown rows and keep emptied bands at 0', () => {
  const f = (id, label, rank, tone) => ({ ...g(id, label, rank, tone), facet: { id: 'st', value: label } });
  const a = f('a', 'Todo', 0, 'todo');
  const b = f('b', 'Done', 1, 'done');
  const source = [it('1', b), it('2', a), it('3', a)];
  const segs = segments(source);
  assert.deepEqual(segs.map((s) => [s.label, s.tone, s.n]), [['Todo', 'todo', 2], ['Done', 'done', 1]]);
  assert.deepEqual(segs[0].facet, { id: 'st', value: 'Todo' });
  const filtered = segments(source, [source[0]]);
  assert.deepEqual(filtered.map((s) => [s.label, s.n]), [['Todo', 0], ['Done', 1]], 'a filter-emptied band stays');
  assert.deepEqual(segments([it('1', a), it('2', a)]), [], 'under two segments');
  assert.deepEqual(segments([it('1', a), it('2', g('x', 'X', 3))]), [], 'a band without a facet');
  assert.deepEqual(segments([it('1', a), it('2')]), [], 'ungrouped rows have no facet');
});
