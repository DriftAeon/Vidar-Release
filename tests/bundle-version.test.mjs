import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleChip } from '../src/panels/bundle-version.ts';

test('older tab -> chip names the installed version a new tab uses', () => {
  assert.equal(bundleChip('2.1.281', '2.1.282'), 'New Tab Uses 2.1.282');
});

test('numeric, not lexical: 2.1.99 is older than 2.1.100', () => {
  assert.notEqual(bundleChip('2.1.99', '2.1.100'), null);
  assert.equal(bundleChip('2.1.100', '2.1.99'), null);
});

test('same or newer bundle -> no chip', () => {
  assert.equal(bundleChip('2.1.282', '2.1.282'), null);
  assert.equal(bundleChip('2.2.0', '2.1.282'), null);
});

test('missing or malformed versions -> no chip', () => {
  assert.equal(bundleChip(undefined, '2.1.282'), null);
  assert.equal(bundleChip('2.1.281', null), null);
  assert.equal(bundleChip('2.1.281-beta', '2.1.282'), null);
});
