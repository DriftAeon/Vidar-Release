import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequesterTab } from '../src/control/requester.ts';

const none = () => null;

test('spawned hosted tab: Rust-supplied tab wins, no frontend lookup', () => {
  const r = { kind: 'falcon_session', session: 's-1', tab: 'tab-7' };
  assert.equal(resolveRequesterTab(r, () => { throw new Error('lookup must not run'); }), 'tab-7');
});

test('adopted tab: bare session falls back to the frontend map', () => {
  const r = { kind: 'falcon_session', session: 's-2' };
  assert.equal(resolveRequesterTab(r, (s) => (s === 's-2' ? 'tab-3' : null)), 'tab-3');
});

test('unknown bare session -> null (no requester)', () => {
  assert.equal(resolveRequesterTab({ kind: 'falcon_session', session: 's-9' }, none), null);
  assert.equal(resolveRequesterTab({ kind: 'falcon_session' }, none), null);
});

test('token requester names its tab', () => {
  assert.equal(resolveRequesterTab({ kind: 'token', tab: 'tab-1' }, none), 'tab-1');
  assert.equal(resolveRequesterTab({ kind: 'token' }, none), null);
});
