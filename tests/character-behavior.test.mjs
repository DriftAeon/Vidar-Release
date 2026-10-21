import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARACTER_ACTIVITY_QUIET_MS,
  characterLoop,
  clipCode,
  clipPlayrate,
  reduceLowContext,
  rawOutputMeansWork,
  reduceOutputPulse,
  reduceOutputQuiet,
} from '../src/character/behavior.ts';

test('context health uses 80/75 hysteresis and stale samples cannot newly assert it', () => {
  assert.equal(reduceLowContext(false, 79, true), false);
  assert.equal(reduceLowContext(false, 80, true), true);
  assert.equal(reduceLowContext(true, 75, true), true);
  assert.equal(reduceLowContext(true, 74.9, true), false);
  assert.equal(reduceLowContext(false, 99, false), false);
  assert.equal(reduceLowContext(true, null, false), true);
});

test('Run is off: activity never leaves Idle, low context still shows Low HP', () => {
  assert.equal(characterLoop(false, false), 'bn01');
  assert.equal(characterLoop(false, true), 'bn02');
  assert.equal(characterLoop(true, false), 'bn01');
  assert.equal(characterLoop(true, true), 'bn02');
});

test('per-clip playrate: keyed by clip code, 1 when missing or invalid', () => {
  assert.equal(clipCode('chr702_bn01'), 'bn01');
  assert.equal(clipCode('chr702'), 'chr702');
  const overrides = { bn01: 0.75, br01: 0, fq01: Number.NaN, bn02: -2 };
  assert.equal(clipPlayrate(overrides, 'chr702_bn01'), 0.75);
  assert.equal(clipPlayrate(overrides, 'chr702_bn02'), 1);
  assert.equal(clipPlayrate(overrides, 'chr702_br01'), 1);
  assert.equal(clipPlayrate(overrides, 'chr702_fq01'), 1);
  assert.equal(clipPlayrate(overrides, 'chr702_e002'), 1);
  assert.equal(clipPlayrate(undefined, 'chr702_bn01'), 1);
});

test('AUTO swaps terriermon Idle for Clip F002, low context still wins', () => {
  assert.equal(characterLoop(false, false, 'auto'), 'f002');
  assert.equal(characterLoop(true, false, 'Auto'), 'f002');
  assert.equal(characterLoop(false, true, 'auto'), 'bn02');
  assert.equal(characterLoop(false, false, 'opus'), 'bn01');
});

test('activity needs two nearby pulses and becomes quiet without per-pulse timer work', () => {
  let result = reduceOutputPulse(undefined, 0);
  const state = result.state;
  assert.equal(result.edge, null);
  assert.equal(state.active, false);

  result = reduceOutputPulse(state, 200);
  assert.equal(result.edge, true);
  assert.equal(state.active, true);
  assert.deepEqual(reduceOutputQuiet(state, 200 + CHARACTER_ACTIVITY_QUIET_MS - 1), {
    edge: null,
    remaining: 1,
  });

  assert.equal(reduceOutputPulse(state, 600).edge, null);
  assert.deepEqual(reduceOutputQuiet(state, 600 + CHARACTER_ACTIVITY_QUIET_MS), {
    edge: false,
    remaining: 0,
  });

  const isolated = reduceOutputPulse(undefined, 0).state;
  assert.equal(reduceOutputPulse(isolated, 351).edge, null);
  assert.equal(isolated.active, false);
});

// The gate itself lives in flushOutput (panels/sessions/output.ts), which this test cannot reach:
// only the predicate is covered here, the wiring is smoke-verified.
test('raw output counts as work only for a TUI that goes quiet when idle', () => {
  assert.equal(rawOutputMeansWork('codex'), false);
  assert.equal(rawOutputMeansWork('gemini'), false);
  assert.equal(rawOutputMeansWork('claude'), true);
  assert.equal(rawOutputMeansWork('shell'), true);
});
