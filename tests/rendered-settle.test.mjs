import test from 'node:test';
import assert from 'node:assert/strict';
import { hostSettleDecision, alreadyAnsweredId } from '../src/panels/rendered-settle.ts';

test('alreadyAnsweredId: all three surfaces of the sidecar refusal yield the id', () => {
  const id = '85454ddf-38b1-4a67-97fa-791bf74ca1ea';
  assert.equal(alreadyAnsweredId(`no pending permission ${id}`), id);
  assert.equal(alreadyAnsweredId(`falcon mutation: no pending permission ${id}`), id);
  assert.equal(alreadyAnsweredId(`Sidecar: no pending permission ${id}`), id);
});

test('alreadyAnsweredId: any other failure is not an already-answered case', () => {
  assert.equal(alreadyAnsweredId('falcon mutation: session not found'), null);
  assert.equal(alreadyAnsweredId('no pending permission'), null);
});

test('settled + sent allow -> allow, label Allowed', () => {
  const r = hostSettleDecision('settled', { behavior: 'allow' }, false);
  assert.equal(r.decision.behavior, 'allow');
  assert.equal(r.label, 'Allowed');
  assert.equal(r.cls, 'allow');
});

test('settled + sent allow + question -> allow, label Answered', () => {
  const r = hostSettleDecision('settled', { behavior: 'allow', updatedInput: { a: 1 } }, true);
  assert.equal(r.label, 'Answered');
  assert.equal(r.cls, 'allow');
  assert.equal(r.decision.behavior, 'allow');
});

test('settled + sent deny with message -> deny, message kept, label includes it', () => {
  const r = hostSettleDecision('settled', { behavior: 'deny', message: 'no thanks' }, false);
  assert.deepEqual(r, { decision: { behavior: 'deny', message: 'no thanks' }, label: 'Denied: no thanks', cls: 'deny' });
});

test('settled + sent null -> neutral settled, not deny-styled', () => {
  const r = hostSettleDecision('settled', null, false);
  assert.deepEqual(r, { decision: { behavior: 'deny', message: 'settled' }, label: 'Settled by the agent', cls: 'settled' });
});

test('cancelled -> deny, label Cancelled by the agent', () => {
  const r = hostSettleDecision('cancelled', { behavior: 'allow' }, false);
  assert.equal(r.cls, 'deny');
  assert.equal(r.label, 'Cancelled by the agent');
  assert.equal(r.decision.behavior, 'deny');
});

test('cancelled-by-exit -> deny, label Cancelled: the agent exited', () => {
  const r = hostSettleDecision('cancelled-by-exit', null, false);
  assert.equal(r.cls, 'deny');
  assert.equal(r.label, 'Cancelled: the agent exited');
});

test('unknown state -> null (caller ignores)', () => {
  assert.equal(hostSettleDecision('replaying', { behavior: 'allow' }, false), null);
  assert.equal(hostSettleDecision('', null, false), null);
});
