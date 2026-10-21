import test from 'node:test';
import assert from 'node:assert/strict';
import { clearModelCache, entryFor, modelCacheSize, modelDigest, tagModel, MODEL_CACHE_LIMIT } from '../src/character/model-cache.ts';

const pixels = { width: 1, height: 1, data: new Uint8ClampedArray(4) };

test('a repeat model sees the stored padding; a revision bump misses and drops old entries', async () => {
  clearModelCache();
  const digest = await modelDigest(new Uint8Array([1, 2, 3]).buffer);
  const first = {};
  tagModel(first, digest, 1);
  entryFor(first).padded.set(0, pixels);
  const again = {};
  tagModel(again, digest, 1);
  assert.equal(entryFor(again).padded.get(0), pixels);
  const bumped = {};
  tagModel(bumped, digest, 2);
  assert.equal(entryFor(bumped).padded.get(0), undefined);
  assert.equal(entryFor(first), undefined);
  assert.equal(modelCacheSize(), 1);
});

test('keeps at most the limit of models, dropping the least recently tagged', () => {
  clearModelCache();
  const owners = Array.from({ length: MODEL_CACHE_LIMIT + 1 }, () => ({}));
  owners.forEach((owner, i) => tagModel(owner, `m${i}`, 1));
  assert.equal(modelCacheSize(), MODEL_CACHE_LIMIT);
  assert.equal(entryFor(owners[0]), undefined);
  assert.ok(entryFor(owners[MODEL_CACHE_LIMIT]));
});
