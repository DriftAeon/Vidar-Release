import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveNames, takeBlockName } from '../src/panels/workbench-names.ts';

// One body: the name cursor is module state, so the sequence below depends on order.
test('restore reservation wraps the cursor; a new name skips reserved and live names', () => {
  reserveNames(['Zulu', 'Alpha']); // max index 25 -> cursor wraps to 0, Alpha held
  assert.equal(takeBlockName([], 0), 'Bravo'); // skips the reserved Alpha
  assert.equal(takeBlockName([{ name: 'Charlie' }], 0), 'Delta'); // skips the live Charlie
});
