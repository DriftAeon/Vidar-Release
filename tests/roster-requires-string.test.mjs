// Regression: `requires` rides in from vidar.json unchecked; a
// bare string crashed the launcher filter (`.every` is not a function). It now reads as one id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shownRootsOf } from '../src/launcher/roster-shown.ts';

test('shownRootsOf: a string requires gates like a one-item list instead of throwing', () => {
  const roots = [{ id: 'a', requires: 'gemini' }, { id: 'b' }];
  assert.deepEqual(shownRootsOf(roots, (id) => id !== 'gemini').map((r) => r.id), ['b']);
  assert.deepEqual(shownRootsOf(roots, () => true).map((r) => r.id), ['a', 'b']);
});
