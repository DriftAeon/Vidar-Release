import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

setupDom({ stubs: {} });
const { defaultAdapter, usableAdapters } = await import('../src/settings/voice-rewrite.ts');

test('an off third agent adapter is hidden unless it is the saved pick', () => {
  const ids = ['claude', 'codex', 'third'];
  const adapter = (id) => ({ id, label: id, modelIds: false, efforts: [], suggestedModels: [] });
  const first = adapter('claude/claude-p');
  const third = adapter('third/rewrite');
  const stock = adapter('voice-stock/openai-compat');
  const on = (id) => id === 'claude';

  assert.equal(defaultAdapter([third, first, stock], on, ids), first);
  assert.deepEqual(usableAdapters([third, first, stock], on, '', ids), [first, stock]);
  assert.deepEqual(usableAdapters([third, first, stock], on, third.id, ids), [first, third, stock]);
});
