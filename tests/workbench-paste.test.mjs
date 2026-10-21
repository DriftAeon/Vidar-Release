import test from 'node:test';
import assert from 'node:assert/strict';
import { trayTakesPaste } from '../src/panels/workbench-paste.ts';

function fakeTarget(matches) {
  return { closest: (selector) => (matches ? {} : null) };
}

test('a target with no editable ancestor is the Tray\'s to take', () => {
  assert.equal(trayTakesPaste(fakeTarget(false)), true);
});

test('an input/textarea/contenteditable target is not the Tray\'s', () => {
  assert.equal(trayTakesPaste(fakeTarget(true)), false);
});

test('a target with no closest method (not an Element) defaults to the Tray', () => {
  assert.equal(trayTakesPaste({}), true);
});

test('a null target defaults to the Tray', () => {
  assert.equal(trayTakesPaste(null), true);
});
