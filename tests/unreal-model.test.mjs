// src/unreal/model.ts: the unreal_status result as groups, the Send target and the Send text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  UNREAL_KEYS, groupDiags, sendTarget, sendText,
  diagKey, currentDismissed, dismissDiag, dismissDiags, MAX_DISMISSED_KEYS, withoutDismissed, storeDismissed, MAX_DISMISSED_PROJECTS,
} from '../src/unreal/model.ts';

const status = JSON.parse(readFileSync(new URL('./fixtures/unreal/status.json', import.meta.url), 'utf8'));

test('status fixture parses into groups', () => {
  const g = groupDiags(status);
  assert.equal(g.errors.length, 3);
  assert.equal(g.warnings.length, 1);
  assert.ok(g.errors.every((d) => d.severity === 'error'));
  assert.equal(g.warnings[0].text, 'Config value missing');
});

test('status fixture keys match the model key list', () => {
  assert.deepEqual(Object.keys(status), [...UNREAL_KEYS.status]);
  assert.deepEqual(Object.keys(status.project), [...UNREAL_KEYS.project]);
  assert.deepEqual(Object.keys(status.build), [...UNREAL_KEYS.result]);
  assert.deepEqual(Object.keys(status.liveCoding), [...UNREAL_KEYS.result]);
  for (const d of status.diags) assert.deepEqual(Object.keys(d), [...UNREAL_KEYS.diag]);
});

test('send target prefers the last live toucher then the focused tab', () => {
  const file = status.diags[3].file;
  const touches = { 'a': { sessionId: 'tab-1' } };
  const last = (p) => (p === file ? touches.a : null);
  assert.equal(sendTarget({ file }, last, () => true, 'tab-9'), 'tab-1');
  assert.equal(sendTarget({ file }, last, () => false, 'tab-9'), 'tab-9');
  assert.equal(sendTarget({ file: null }, last, () => true, 'tab-9'), 'tab-9');
  assert.equal(sendTarget({ file }, () => null, () => true, null), null);
});

test('send text strips control characters and never ends in \\r', () => {
  const d = status.diags[3];
  assert.equal(sendText(d), "Unreal error at C:\\Projects\\Acme\\Source\\Acme\\Foo.cpp(42): C2065: 'Bar': undeclared identifier");
  const dirty = sendText({ file: 'C:\\x.cpp', line: 1, text: 'a\x1b[31mb\x85c\u2028d\u202Ee\u2066f\r\n\r' });
  assert.ok(!/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(dirty));
  assert.ok(!dirty.endsWith('\r'));
  const big = sendText({ file: 'C:\\x.cpp', line: 1, text: '\u00e9'.repeat(2000) });
  assert.ok(new TextEncoder().encode(big).length <= 1024);
  assert.ok(!big.includes('\ufffd'));
});

test('diag key joins severity, file, line and text', () => {
  assert.equal(diagKey({ severity: 'error', file: 'a.cpp', line: 3, text: 'x' }), 'error|a.cpp|3|x');
  assert.equal(diagKey({ severity: 'warning', file: null, line: null, text: 'y' }), 'warning|||y');
});

test('dismissDiags adds every key once and respects the bound', () => {
  const s = { ...status, build: { result: 'failed', at: 10 }, liveCoding: null };
  const entry = currentDismissed(undefined, s);
  const one = dismissDiag(entry, s.diags[0]);
  const all = dismissDiags(one, s.diags);
  assert.equal(all.keys.length, new Set(s.diags.map(diagKey)).size);
  assert.equal(dismissDiags(all, s.diags), all);
  assert.equal(withoutDismissed(s, all).diags.length, 0);
  const many = Array.from({ length: MAX_DISMISSED_KEYS + 5 }, (_, i) => ({ severity: 'error', file: null, line: i, text: 't' }));
  const capped = dismissDiags(entry, many);
  assert.equal(capped.keys.length, MAX_DISMISSED_KEYS);
  assert.equal(capped.keys.at(-1), diagKey(many.at(-1)));
});

test('dismissing hides only that row and survives while build and live times hold', () => {
  const s = { ...status, build: { result: 'failed', at: 10 }, liveCoding: null };
  let entry = currentDismissed(undefined, s);
  assert.deepEqual(entry, { build: 10, live: null, keys: [] });
  entry = dismissDiag(entry, s.diags[3]);
  assert.equal(dismissDiag(entry, s.diags[3]), entry);
  const shown = withoutDismissed(s, entry);
  assert.equal(shown.diags.length, s.diags.length - 1);
  assert.equal(groupDiags(shown).errors.length, 2);
  assert.equal(currentDismissed(entry, s), entry);
});

test('a new build or live-coding time clears the dismissed set', () => {
  const s = { build: { at: 10 }, liveCoding: { at: 5 } };
  const entry = { build: 10, live: 5, keys: ['k'] };
  assert.deepEqual(currentDismissed(entry, { build: { at: 11 }, liveCoding: { at: 5 } }).keys, []);
  assert.deepEqual(currentDismissed(entry, { build: { at: 10 }, liveCoding: { at: 6 } }).keys, []);
  assert.deepEqual(currentDismissed(entry, { build: { at: 10 }, liveCoding: null }).keys, []);
  assert.equal(currentDismissed(entry, s), entry);
});

test('stored map replaces one root, drops an empty entry and bounds projects', () => {
  const e = { build: 1, live: null, keys: ['k'] };
  let map = storeDismissed(undefined, 'r0', e);
  assert.deepEqual(map, { r0: e });
  assert.deepEqual(storeDismissed(map, 'r0', { ...e, keys: [] }), {});
  for (let i = 1; i <= MAX_DISMISSED_PROJECTS; i++) map = storeDismissed(map, `r${i}`, e);
  assert.equal(Object.keys(map).length, MAX_DISMISSED_PROJECTS);
  assert.ok(!('r0' in map));
});
