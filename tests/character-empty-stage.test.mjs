// Character window empty state: Add Character only for a loaded, empty list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyStage } from '../src/character/empty-stage.ts';

test('loaded and empty offers Add Character; loading shows nothing; failed is not-loaded', () => {
  assert.equal(emptyStage({ packs: [] }, false), 'add');
  assert.equal(emptyStage(null, false), 'none', 'still loading');
  assert.equal(emptyStage(null, true), 'not-loaded');
  assert.equal(emptyStage({ packs: [] }, true), 'not-loaded');
  assert.equal(emptyStage({ packs: [{}] }, false), 'none');
});

test('the Character module no longer waits on a pack', () => {
  const mods = JSON.parse(readFileSync(new URL('../contracts/modules.json', import.meta.url), 'utf8'));
  const all = Object.values(mods).flat();
  const character = all.find((m) => m && m.id === 'character');
  assert.ok(character, 'character module declared');
  assert.deepEqual(character.when ?? {}, {});
});
