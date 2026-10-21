// Speak Rewrite row: the pure parts (names, option lists, prefill, the pick, the row error).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

setupDom({ stubs: {} });
const m = await import('../src/settings/voice-rewrite.ts');

const claude = {
  id: 'claude/claude-p', label: 'Claude P', modelIds: true, efforts: ['low', 'medium', 'high'],
  suggestedModels: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { id: 'claude-x', label: null }],
};
const codex = {
  id: 'codex/codex-exec', label: 'Codex', modelIds: true, efforts: ['low', 'medium', 'high', 'xhigh'],
  suggestedModels: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }],
};
const lmA = { id: 'voice-stock/openai-compat', label: 'OpenAI', modelIds: true, efforts: [], suggestedModels: [] };
const other = { id: 'pack/thing', label: 'Thing', modelIds: false, efforts: [], suggestedModels: [] };
const lm = {
  models: [
    { id: 'embed-a', kind: 'embeddings', state: 'loaded' },
    { id: 'llm-b', kind: 'llm', state: 'not-loaded' },
    { id: 'llm-c', kind: 'llm', state: 'loaded' },
  ],
};

test('display names', () => {
  assert.deepEqual(m.adapterOptions([claude, codex, lmA, other]).map((o) => o.label), ['Claude', 'Codex', 'LM Studio', 'Thing']);
});

test('default adapter and usable list follow the shipped, on agents', () => {
  const all = [claude, codex, lmA];
  const ids = (l) => l.map((a) => a.id);
  assert.equal(m.defaultAdapter(all, () => true).id, 'claude/claude-p');
  assert.equal(m.defaultAdapter(all, (id) => id === 'codex').id, 'codex/codex-exec');
  assert.equal(m.defaultAdapter([codex, lmA], () => true).id, 'codex/codex-exec');
  assert.equal(m.defaultAdapter(all, () => false), undefined);
  assert.deepEqual(ids(m.usableAdapters([codex, claude, lmA], () => true)), ['claude/claude-p', 'codex/codex-exec', 'voice-stock/openai-compat']);
  assert.deepEqual(ids(m.usableAdapters(all, (id) => id === 'codex')), ['codex/codex-exec', 'voice-stock/openai-compat']);
  assert.deepEqual(ids(m.usableAdapters(all, (id) => id === 'codex', 'claude/claude-p')), ['codex/codex-exec', 'claude/claude-p', 'voice-stock/openai-compat']);
});

test('model options: claude suggestions, LM Studio LLMs only, none without modelIds', () => {
  assert.deepEqual(m.modelOptions(claude, null), [
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { value: 'claude-x', label: 'claude-x' }]);
  assert.deepEqual(m.modelOptions(lmA, lm).map((o) => o.value), ['llm-b', 'llm-c']);
  assert.deepEqual(m.modelOptions(lmA, null), []);
  assert.deepEqual(m.modelOptions(other, lm), []);
});

test('prefill', () => {
  assert.deepEqual(m.prefillPick(claude, null), { adapter: 'claude/claude-p', model: 'claude-sonnet-5-5', effort: 'low' });
  assert.deepEqual(m.prefillPick(codex, null), { adapter: 'codex/codex-exec', model: 'gpt-6.1-sol', effort: 'low' });
  assert.deepEqual(m.prefillPick({ ...codex, suggestedModels: [] }, null), { adapter: 'codex/codex-exec' });
  assert.deepEqual(m.prefillPick(lmA, lm), { adapter: 'voice-stock/openai-compat', model: 'llm-c' });
  const idle = { models: [{ id: 'llm-b', kind: 'llm', state: 'not-loaded' }] };
  assert.deepEqual(m.prefillPick(lmA, idle), { adapter: 'voice-stock/openai-compat', model: 'llm-b' });
  assert.deepEqual(m.prefillPick(lmA, null), { adapter: 'voice-stock/openai-compat' });
  assert.deepEqual(m.prefillPick(other, lm), { adapter: 'pack/thing' });
});

test('buildPick omits empties and drops effort without a list', () => {
  assert.deepEqual(m.buildPick(claude, 'claude-x', 'high'), { adapter: 'claude/claude-p', model: 'claude-x', effort: 'high' });
  assert.deepEqual(m.buildPick(claude, '', ''), { adapter: 'claude/claude-p' });
  assert.deepEqual(m.buildPick(lmA, 'llm-b', 'high'), { adapter: 'voice-stock/openai-compat', model: 'llm-b' });
  assert.equal(m.buildPick(undefined, 'x', 'y'), null);
});

test('rowError shows reason for broken and missing only', () => {
  assert.equal(m.rowError({ state: 'broken', reason: 'bad' }), 'bad');
  assert.equal(m.rowError({ state: 'missing', reason: 'gone' }), 'gone');
  assert.equal(m.rowError({ state: 'filled', reason: 'x' }), '');
  assert.equal(m.rowError({ state: 'empty', reason: null }), '');
});
