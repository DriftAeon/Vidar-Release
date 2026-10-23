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

test('Run is off: activity never leaves the idle role, low context still shows tired', () => {
  assert.equal(characterLoop(false, false), 'idle');
  assert.equal(characterLoop(false, true), 'tired');
  assert.equal(characterLoop(true, false), 'idle');
  assert.equal(characterLoop(true, true), 'tired');
});

test('per-clip playrate: keyed by clip code, 1 when missing or invalid', () => {
  assert.equal(clipCode('hero_idle'), 'idle');
  assert.equal(clipCode('hero'), 'hero');
  const overrides = { idle: 0.75, run: 0, yes: Number.NaN, tired: -2 };
  assert.equal(clipPlayrate(overrides, 'hero_idle'), 0.75);
  assert.equal(clipPlayrate(overrides, 'hero_tired'), 1);
  assert.equal(clipPlayrate(overrides, 'hero_run'), 1);
  assert.equal(clipPlayrate(overrides, 'hero_yes'), 1);
  assert.equal(clipPlayrate(overrides, 'hero_wave'), 1);
  assert.equal(clipPlayrate(undefined, 'hero_idle'), 1);
});

test('AUTO swaps the idle role for rest, low context still wins', () => {
  assert.equal(characterLoop(false, false, 'auto'), 'rest');
  assert.equal(characterLoop(true, false, 'Auto'), 'rest');
  assert.equal(characterLoop(false, true, 'auto'), 'tired');
  assert.equal(characterLoop(false, false, 'opus'), 'idle');
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
