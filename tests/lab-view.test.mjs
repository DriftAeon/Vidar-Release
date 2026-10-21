// src/lab/commands.ts: the copied live command must be one the runner accepts.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import { missingInputs, guard } from './helpers/optional-input.mjs';
import { ARMS, REPEATS, SESSION_CAP, dryCommand, liveCommand, liveSessions } from '../src/lab/commands.ts';
const skipPlan = missingInputs(import.meta.url, '../tools/lab/plan.mjs');
const { DEFAULTS } = skipPlan ? {} : await import('../tools/lab/plan.mjs');
const test = guard(baseTest, skipPlan);

test('TS plan constants equal the runner defaults', () => {
  assert.equal(REPEATS, DEFAULTS.repeats);
  assert.equal(SESSION_CAP, DEFAULTS.maxSessions);
  assert.equal(ARMS, 2); // plan.mjs plans with and without per repeat
});

test('--confirm is exactly cases x repeats x arms; over the cap there is no live command', () => {
  assert.equal(liveSessions(2), 2 * DEFAULTS.repeats * 2);
  assert.equal(liveCommand('r', 'global', 2), `${dryCommand('r', 'global')} --live --confirm 12`);
  assert.equal(liveCommand('r', 'vidar', 1), `${dryCommand('r', 'vidar')} --live --confirm 6`);
  assert.equal(liveCommand('r', 'global', 3), null);
  assert.equal(liveCommand('r', 'global', 0), `${dryCommand('r', 'global')} --live --confirm 0`);
});
