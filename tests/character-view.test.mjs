import test from 'node:test';
import assert from 'node:assert/strict';
import { validateView } from '../src/character/view.ts';

test('a well-formed view round-trips', () => {
  const raw = { position: [1, 2, 3], target: [0, 0.5, 0], zoom: 1.2 };
  assert.deepEqual(validateView(raw), raw);
});

test('non-finite numbers, wrong shape and non-positive zoom are rejected', () => {
  assert.equal(validateView(null), null);
  assert.equal(validateView(undefined), null);
  assert.equal(validateView('nope'), null);
  assert.equal(validateView({ position: [1, 2], target: [0, 0, 0], zoom: 1 }), null);
  assert.equal(validateView({ position: [1, 2, Infinity], target: [0, 0, 0], zoom: 1 }), null);
  assert.equal(validateView({ position: [1, 2, NaN], target: [0, 0, 0], zoom: 1 }), null);
  assert.equal(validateView({ position: [1, 2, 3], target: [0, 0, 0], zoom: 0 }), null);
  assert.equal(validateView({ position: [1, 2, 3], target: [0, 0, 0], zoom: -1 }), null);
  assert.equal(validateView({ position: [1, 2, 3], target: [0, 0, 0], zoom: 'x' }), null);
});
