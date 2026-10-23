// Character window stage slot: the vidar.json `characterStage` pick against the stage listing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraFar, chooseStage, clampMinDistance, imageMime, STAGE_FALLBACK_NOTE } from '../src/character/stage-pick.ts';

const yard = { id: 'yard', label: 'Yard', background: { image: 'sky.png' } };
const list = {
  stages: [
    { id: 'yard', folder: 'yard', status: 'ok', stage: yard },
    { id: 'old', folder: 'old', status: 'broken', reason: 'Needs Vidar 9.0.0 or Newer' },
  ],
};

test('no pick is the default stage with no note', () => {
  for (const pick of [undefined, null, '', '  ', 3, {}]) {
    assert.deepEqual(chooseStage(pick, list), { kind: 'default', note: null }, String(pick));
  }
  assert.deepEqual(chooseStage(undefined, null), { kind: 'default', note: null }, 'a failed list does not matter without a pick');
});

test('a listed ok stage is used', () => {
  assert.deepEqual(chooseStage('yard', list), { kind: 'pack', stage: yard });
});

test('a missing, broken or unlisted pick falls back to the default with the note', () => {
  assert.equal(STAGE_FALLBACK_NOTE, 'Stage Not Loaded, Showing Default');
  assert.deepEqual(chooseStage('gone', list), { kind: 'default', note: STAGE_FALLBACK_NOTE });
  assert.deepEqual(chooseStage('old', list), { kind: 'default', note: STAGE_FALLBACK_NOTE });
  assert.deepEqual(chooseStage('yard', null), { kind: 'default', note: STAGE_FALLBACK_NOTE }, 'listing failed');
  assert.deepEqual(chooseStage('yard', { stages: [{ id: 'yard', folder: 'yard', status: 'ok' }] }),
    { kind: 'default', note: STAGE_FALLBACK_NOTE }, 'ok without a stage body');
});

test('the far plane clears the furthest orbit plus the character', () => {
  // pack { far: 10, maxDistance: 5000 }, character radius 3
  assert.ok(cameraFar(300, 10, 5000, 3) >= 5000 + 3 * 2);
  assert.ok(cameraFar(1000, 10, 5000, null) >= 5000);
  assert.equal(cameraFar(1000, 2000, 12, 1), 2000, 'a generous far stays');
});

test('a pack min distance never exceeds its max after defaults', () => {
  assert.equal(clampMinDistance(30, 12), 12, '{ minDistance: 30 } with the default max 12');
  assert.equal(clampMinDistance(2, 12), 2);
});

test('image bytes are sniffed as png, jpg or webp only', () => {
  const bytes = (...b) => new Uint8Array([...b, ...new Array(12).fill(0)]).buffer;
  assert.equal(imageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(imageMime(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(imageMime(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)), 'image/webp');
  assert.equal(imageMime(bytes(0x47, 0x49, 0x46, 0x38)), null, 'gif');
  assert.equal(imageMime(new ArrayBuffer(2)), null, 'too short');
});
