import test from 'node:test';
import assert from 'node:assert/strict';
import { dilateCoverage } from '../src/character/atlas-padding.ts';

function image(width, height, fill) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set(fill, i * 4);
  return pixels;
}
const pixel = (pixels, x, y, width) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

test('fills padding from the nearest covered pixel and leaves covered pixels alone', () => {
  const width = 8, height = 8;
  const pixels = image(width, height, [0, 0, 255, 255]);
  const coverage = new Uint8Array(width * height);
  const paint = (x, y, color) => { pixels.set(color, (y * width + x) * 4); coverage[y * width + x] = 1; };
  paint(1, 1, [255, 0, 0, 255]);
  paint(6, 6, [0, 255, 0, 255]);
  const before = pixels.slice();
  const result = dilateCoverage(pixels, coverage, width, height, 8);
  assert.deepEqual(pixels, before, 'source pixels must stay unchanged');
  assert.deepEqual(pixel(result, 1, 1, width), [255, 0, 0, 255]);
  assert.deepEqual(pixel(result, 6, 6, width), [0, 255, 0, 255]);
  assert.deepEqual(pixel(result, 2, 2, width), [255, 0, 0, 255], 'near the red seed');
  assert.deepEqual(pixel(result, 5, 5, width), [0, 255, 0, 255], 'near the green seed');
  assert.deepEqual(pixel(result, 0, 6, width), [0, 255, 0, 255], 'wraps horizontally: x=0 is two texels from green across the edge');
  assert.ok(!Array.from(result).some((value, i) => i % 4 === 2 && value === 255), 'no padding color survives within reach');
});

test('leaves the image unchanged without any coverage', () => {
  const pixels = image(4, 4, [10, 20, 30, 255]);
  const result = dilateCoverage(pixels, new Uint8Array(16), 4, 4, 4);
  assert.deepEqual(result, pixels);
});

test('rejects mismatched sizes', () => {
  assert.throws(() => dilateCoverage(new Uint8ClampedArray(16), new Uint8Array(3), 2, 2, 2));
});
