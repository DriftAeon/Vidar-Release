import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSnapshot, cardsSnapshot } from '../src/panels/rendered-drive.ts';

test('pending question card: two questions with their option labels, settled null', () => {
  const r = cardSnapshot({
    requestId: 'req-1',
    tool: 'AskUserQuestion',
    questions: [['Yes', 'No'], ['Red', 'Green', 'Blue']],
    result: null,
  });
  assert.deepEqual(r, {
    id: 'req-1',
    tool: 'AskUserQuestion',
    options: [['Yes', 'No'], ['Red', 'Green', 'Blue']],
    settled: null,
  });
});

test('settled card keeps the result text', () => {
  const r = cardSnapshot({
    requestId: 'req-2',
    tool: 'AskUserQuestion',
    questions: [['Yes', 'No']],
    result: 'Answered',
  });
  assert.equal(r.settled, 'Answered');
  assert.deepEqual(r.options, [['Yes', 'No']]);
});

test('non-question approval card: no questions -> empty options array', () => {
  const r = cardSnapshot({ requestId: 'req-3', tool: 'Bash', result: null });
  assert.deepEqual(r, { id: 'req-3', tool: 'Bash', options: [], settled: null });
  assert.ok(Array.isArray(r.options));
});

test('missing dataset fields become empty strings, never undefined', () => {
  const r = cardSnapshot({});
  assert.deepEqual(r, { id: '', tool: '', options: [], settled: null });
  assert.equal(typeof r.id, 'string');
  assert.equal(typeof r.tool, 'string');
});

test('null dataset fields and null option labels also become empty strings', () => {
  const r = cardSnapshot({ requestId: null, tool: null, questions: [[null, 'B', undefined]] });
  assert.deepEqual(r, { id: '', tool: '', options: [['', 'B', '']], settled: null });
});

test('a question with no options yields an empty inner array, not a dropped question', () => {
  const r = cardSnapshot({ requestId: 'req-4', tool: 'AskUserQuestion', questions: [[], ['Only']] });
  assert.deepEqual(r.options, [[], ['Only']]);
});

test('cardsSnapshot maps in order and is empty for no cards', () => {
  assert.deepEqual(cardsSnapshot([]), []);
  const r = cardsSnapshot([
    { requestId: 'a', tool: 'Bash', result: 'Allowed' },
    { requestId: 'b', tool: 'AskUserQuestion', questions: [['1', '2']] },
  ]);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((c) => c.id), ['a', 'b']);
  assert.equal(r[0].settled, 'Allowed');
  assert.deepEqual(r[1].options, [['1', '2']]);
  assert.equal(r[1].settled, null);
});
