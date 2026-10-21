import test from 'node:test';
import assert from 'node:assert/strict';
import { softenCelRamp } from '../src/character/cel-ramp.ts';

test('softens a sharp shadow boundary while preserving flat ends and channel colors', () => {
  const row = new Uint8ClampedArray(128 * 4);
  for (let x = 0; x < 128; x++) row.set(x < 64 ? [40, 20, 60, 255] : [220, 180, 200, 255], x * 4);
  const before = row.slice();
  const result = softenCelRamp(row);
  assert.deepEqual(row, before, 'source texture must stay unchanged');
  assert.deepEqual(Array.from(result.slice(0, 4)), [40, 20, 60, 255]);
  assert.deepEqual(Array.from(result.slice(-4)), [220, 180, 200, 255]);
  let maxStep = 0;
  for (let x = 1; x < 128; x++) {
    const current = result[x * 4];
    assert.ok(current >= result[(x - 1) * 4], 'a monotonic ramp must stay monotonic');
    maxStep = Math.max(maxStep, current - result[(x - 1) * 4]);
    assert.equal(result[x * 4 + 3], 255);
  }
  assert.ok(maxStep < 20, `the original 180-level step must become gradual, got ${maxStep}`);
  assert.ok(result[63 * 4] > 40 && result[64 * 4] < 220, 'blend both sides of the boundary');
});

test('constant ramps retain exact values without darkening the borders', () => {
  for (const width of [1, 128, 256]) {
    const row = new Uint8ClampedArray(width * 4);
    for (let x = 0; x < width; x++) row.set([51, 77, 203, 255], x * 4);
    assert.deepEqual(Array.from(softenCelRamp(row)), Array.from(row));
  }
});
