import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stepBudget, resetBudget, budgetStatus, LOCK_MS } from '../tools/drive/drive-budget.mjs';

const T0 = 1_000_000_000_000;

const made = [];
function tmpFile() {
  const file = path.join(os.tmpdir(), `vidar-drive-budget-test-${Math.random().toString(36).slice(2)}.json`);
  made.push(file);
  return file;
}
after(() => { for (const f of made) fs.rmSync(f, { force: true }); });

function stored(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('leaf: a fresh import has no side effects on the real budget file', async () => {
  const real = path.join(os.tmpdir(), 'vidar-drive-budget.json');
  const before = fs.existsSync(real) ? fs.statSync(real).mtimeMs : null;
  const mod = await import(`../tools/drive/drive-budget.mjs?probe=${Date.now()}`);
  assert.equal(typeof mod.stepBudget, 'function');
  assert.equal(fs.existsSync(real) ? fs.statSync(real).mtimeMs : null, before);
});

test('undefined or non-positive-integer env value: no cap, file untouched', () => {
  const file = tmpFile();
  for (const env of [undefined, '', '0', 'abc', '-3', '2.5']) {
    assert.equal(stepBudget(file, env, T0), null, `env ${JSON.stringify(env)}`);
    assert.equal(fs.existsSync(file), false, `env ${JSON.stringify(env)}`);
  }
});

test('a live record binds a caller whose env is unset: steps, then refuses; status reads without writing', () => {
  const file = tmpFile();
  stepBudget(file, '2', T0); // armed 2, remaining 1
  assert.deepEqual(stepBudget(file, undefined, T0 + 1), { armed: 2, remaining: 0, envIgnored: false });
  assert.equal(stepBudget(file, undefined, T0 + 2).remaining, -1);
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(budgetStatus(file, T0 + 3),
    { armed: 2, remaining: 0, armedAt: T0, expiresAt: T0 + LOCK_MS, resetBy: null });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(budgetStatus(file, T0 + LOCK_MS), null);
  assert.equal(stepBudget(file, undefined, T0 + LOCK_MS), null);
});

test('fresh arm: no file yet, arms to the env value, stamps armedAt and decrements once', () => {
  const file = tmpFile();
  assert.deepEqual(stepBudget(file, '3', T0), { armed: 3, remaining: 2, envIgnored: false });
  assert.deepEqual(stored(file), { armed: 3, remaining: 2, armedAt: T0 });
});

test('decrement to refusal: remaining hits 0, next call reports -1 and the file stays at 0', () => {
  const file = tmpFile();
  assert.deepEqual(stepBudget(file, '1', T0), { armed: 1, remaining: 0, envIgnored: false });
  assert.deepEqual(stepBudget(file, '1', T0 + 1), { armed: 1, remaining: -1, envIgnored: false });
  assert.deepEqual(stored(file), { armed: 1, remaining: 0, armedAt: T0 });
});

test('a different env value does NOT re-arm a live record', () => {
  const file = tmpFile();
  stepBudget(file, '2', T0); // armed 2, remaining 1
  assert.deepEqual(stepBudget(file, '5', T0 + 1000), { armed: 2, remaining: 0, envIgnored: true });
  assert.equal(stored(file).armed, 2);
});

test('exhaustion is final for the live record, whatever the env value becomes', () => {
  const file = tmpFile();
  stepBudget(file, '1', T0); // armed 1, remaining 0
  for (const env of ['1', '60', '200']) {
    assert.equal(stepBudget(file, env, T0 + 60_000).remaining, -1, `env ${env}`);
  }
  assert.deepEqual(stored(file), { armed: 1, remaining: 0, armedAt: T0 });
});

test('a record older than LOCK_MS no longer binds: the next call arms fresh from the env value', () => {
  const file = tmpFile();
  stepBudget(file, '1', T0); // exhausted after this
  assert.deepEqual(stepBudget(file, '4', T0 + LOCK_MS), { armed: 4, remaining: 3, envIgnored: false });
  assert.deepEqual(stored(file), { armed: 4, remaining: 3, armedAt: T0 + LOCK_MS });
});

test('a record with no armedAt is treated as stale and re-armed', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ armed: 1, remaining: 0 }));
  assert.deepEqual(stepBudget(file, '3', T0), { armed: 3, remaining: 2, envIgnored: false });
});

test('a future-dated armedAt does not bind forever', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ armed: 500, remaining: 500, armedAt: T0 + LOCK_MS * 10 }));
  assert.deepEqual(stepBudget(file, '3', T0), { armed: 3, remaining: 2, envIgnored: false });
});

test('unchanged when the env value equals what is already armed', () => {
  const file = tmpFile();
  stepBudget(file, '4', T0);
  assert.deepEqual(stepBudget(file, '4', T0 + 1), { armed: 4, remaining: 2, envIgnored: false });
});

test('reset without byOrchestrator writes nothing and returns null', () => {
  const file = tmpFile();
  stepBudget(file, '1', T0); // exhausted
  assert.equal(resetBudget(file, '200', { now: T0 + 1 }), null);
  assert.equal(resetBudget(file, '200'), null);
  assert.deepEqual(stored(file), { armed: 1, remaining: 0, armedAt: T0 });
});

test('orchestrator reset re-arms and records that it was used', () => {
  const file = tmpFile();
  stepBudget(file, '1', T0); // exhausted
  const r = resetBudget(file, '7', { byOrchestrator: true, now: T0 + 5 });
  assert.deepEqual(r, { armed: 7, remaining: 7, armedAt: T0 + 5, resetBy: 'orchestrator' });
  assert.deepEqual(stepBudget(file, '7', T0 + 6), { armed: 7, remaining: 6, envIgnored: false });
  assert.equal(stored(file).resetBy, 'orchestrator');
});
