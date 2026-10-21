import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateThemeId, LEGACY_THEME_IDS } from '../src/theme-ids.ts';

test('old palette ids map to the new ids', () => {
  assert.equal(migrateThemeId('zero'), 'onyx');
  assert.equal(migrateThemeId('jager'), 'cobalt');
  assert.equal(migrateThemeId('schneider'), 'ember');
  assert.equal(migrateThemeId('panzer'), 'olive');
});

test('new ids and unknown values pass through unchanged', () => {
  for (const v of ['onyx', 'cobalt', 'ember', 'olive', 'nope', '', undefined, null, 3]) {
    assert.equal(migrateThemeId(v), v);
  }
});

test('inherited keys are not legacy ids', () => {
  assert.equal(migrateThemeId('constructor'), 'constructor');
  assert.equal(migrateThemeId('toString'), 'toString');
});

test('the map holds exactly the four old ids', () => {
  assert.deepEqual(Object.keys(LEGACY_THEME_IDS), ['zero', 'jager', 'schneider', 'panzer']);
});
