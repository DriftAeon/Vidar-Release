// Settings rail order: core A-Z, then Modules, then the rest of the module group A-Z.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

setupDom({ stubs: {} });
const { orderCategories, categoryList } = await import('../src/settings/registry.ts');

const entries = [
  ['flow', 'Flow', 'module'],
  ['keybinds', 'Keybinds'],
  ['characters', 'Characters', 'module'],
  ['general', 'General'],
  ['audio', 'Audio', 'module'],
  ['build', 'Build'],
  ['modules', 'Modules', 'module'],
  ['cards', 'Cards'],
];

test('core A-Z, then Modules, then the other module pages A-Z', () => {
  const ids = orderCategories(entries).map(([id]) => id);
  assert.deepEqual(ids, ['build', 'cards', 'general', 'keybinds', 'modules', 'audio', 'characters', 'flow']);
});

test('registration order does not change the rail', () => {
  const want = orderCategories(entries).map(([id]) => id);
  for (const shuffled of [entries.slice().reverse(), [...entries.slice(4), ...entries.slice(0, 4)]]) {
    assert.deepEqual(orderCategories(shuffled).map(([id]) => id), want);
  }
});

test('the registry keeps the group with Audio', () => {
  assert.equal(categoryList().find(([id]) => id === 'audio')?.[2], 'module');
});
