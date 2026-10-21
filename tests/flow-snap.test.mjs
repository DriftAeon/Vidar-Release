import test from 'node:test';
import assert from 'node:assert/strict';
import { snapCoord, snapPoint, withinSlack, mintId, isValidId } from '../src/flow/snap.ts';

test('snapCoord: rounds to the nearest grid multiple', () => {
  assert.equal(snapCoord(0, 16), 0);
  assert.equal(snapCoord(7, 16), 0);
  assert.equal(snapCoord(8, 16), 16);
  assert.equal(snapCoord(9, 16), 16);
  assert.equal(snapCoord(23, 16), 16);
  assert.equal(snapCoord(24, 16), 32);
});

test('snapCoord: negative coordinates round toward the nearer grid line', () => {
  // Math.round(-7 / 16) * 16 is -0, not 0; assert.equal (strict/Object.is) treats -0 !== 0,
  // so compare the value coerced through +0 rather than the raw result.
  assert.equal(snapCoord(-7, 16) + 0, 0);
  assert.equal(snapCoord(-9, 16), -16);
  assert.equal(snapCoord(-16, 16), -16);
});

test('snapPoint: rounds both axes independently', () => {
  assert.deepEqual(snapPoint(9, 23, 16), { x: 16, y: 16 });
  assert.deepEqual(snapPoint(-9, 7, 16), { x: -16, y: 0 });
});

test('withinSlack: inside the rect itself is always within slack', () => {
  const rect = { left: 100, right: 120, top: 200, bottom: 216 };
  assert.equal(withinSlack(110, 208, rect, 0), true);
  assert.equal(withinSlack(110, 208, rect, 20), true);
});

test('withinSlack: point outside the rect but inside the ~20px magnet radius', () => {
  const rect = { left: 100, right: 120, top: 200, bottom: 216 };
  // 15px left of the rect's left edge — inside a 20px slack, outside a 10px one
  assert.equal(withinSlack(85, 208, rect, 20), true);
  assert.equal(withinSlack(85, 208, rect, 10), false);
});

test('withinSlack: point far outside the rect on any axis fails regardless of slack', () => {
  const rect = { left: 100, right: 120, top: 200, bottom: 216 };
  assert.equal(withinSlack(85, 500, rect, 20), false);
  assert.equal(withinSlack(500, 208, rect, 20), false);
});

test('withinSlack: exactly at the slack boundary is inclusive', () => {
  const rect = { left: 100, right: 120, top: 200, bottom: 216 };
  assert.equal(withinSlack(80, 208, rect, 20), true);
  assert.equal(withinSlack(79.999, 208, rect, 20), false);
});

test('mintId: lowercases, strips to the id charset, and numbers from 1', () => {
  assert.equal(mintId('Plan Review', new Set()), 'plan-review-1');
  assert.equal(mintId('123', new Set()), 'node-1');
});

test('mintId: increments past a collision', () => {
  assert.equal(mintId('agent', new Set(['agent-1'])), 'agent-2');
});

test('mintId: "input" base mints the bare frozen id when free (§2)', () => {
  assert.equal(mintId('input', new Set()), 'input');
  assert.equal(mintId('input', new Set()), 'input');
});

test('mintId: "input" base falls back to the numbered form once "input" is taken', () => {
  assert.equal(mintId('input', new Set(['input'])), 'input-1');
});

test('mintId: every output matches the §2 id charset', () => {
  for (const [base, used] of [['Plan Review', new Set()], ['123', new Set()], ['agent', new Set(['agent-1'])], ['input', new Set()]]) {
    assert.equal(isValidId(mintId(base, used)), true);
  }
});

test('snapCoord: documents the round-half-up asymmetry at a tie (±8 of a 16 grid)', () => {
  // Math.round rounds .5 toward +Infinity, so +8 (exactly half of 16) rounds up
  // to 16 but -8 rounds up too, i.e. toward 0 rather than down to -16 — the two
  // ties are not mirror images of each other.
  assert.equal(snapCoord(8, 16), 16);
  assert.equal(snapCoord(-8, 16) + 0, 0);
});
