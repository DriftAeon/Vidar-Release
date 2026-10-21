import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gridOpacityCssValue } from '../src/flow/grid-opacity-value.ts';

test('Flow grid opacity uses a CSS percentage, including zero and the saved value', () => {
  assert.equal(gridOpacityCssValue(0), '0%');
  assert.equal(gridOpacityCssValue(30), '30%');
  assert.equal(gridOpacityCssValue(100), '100%');
  assert.equal(gridOpacityCssValue(undefined), '55%');
  assert.equal(gridOpacityCssValue(Number.NaN), '55%');
});

test('the grid pseudo-element consumes the percentage inherited from the Flow root', () => {
  const css = readFileSync(new URL('../src/styles/flow.css', import.meta.url), 'utf8');
  const rule = css.match(/\.flow-snap-grid::before\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule, 'grid pseudo-element rule exists');
  assert.equal((rule.match(/var\(--flow-grid-opacity, 55%\)/g) ?? []).length, 2);
  assert.doesNotMatch(rule, /calc\(/);
});
