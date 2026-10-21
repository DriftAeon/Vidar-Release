import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ISSUE_KEYS, normaliseSite, sendText } from '../src/jira/model.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/jira/issues.json', import.meta.url), 'utf8'));

test('issues fixture keys match the model key list', () => {
  assert.ok(fixture.issues.length > 0);
  for (const issue of fixture.issues) {
    assert.deepEqual(Object.keys(issue).sort(), [...ISSUE_KEYS].sort());
  }
});

test('send text strips Cc, Cf, Zl and Zp characters (bidi, zero-width, U+FEFF, tag block), caps on a code-point boundary and never ends in \\r', () => {
  const dirty = sendText({ key: 'K\u202e\u200b', summary: 'a\ufeff\u{e0041}b\u2028c\u2029d\re\nf\tg\r' });
  assert.equal(dirty, 'K: abcdefg');
  assert.doesNotMatch(dirty, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  assert.ok(!dirty.endsWith('\r'));

  const big = sendText({ key: 'K', summary: '😀'.repeat(300) });
  assert.equal(big, `K: ${'😀'.repeat(255)}`);
  assert.equal(new TextEncoder().encode(big).length, 1023);
  assert.ok(!big.includes('\ufffd'));
  assert.ok(!big.endsWith('\r'));
});

test('normaliseSite accepts the three forms and refuses invalid sites', () => {
  for (const input of ['name', 'name.atlassian.net', 'https://name.atlassian.net/', '  HTTPS://NaMe.AtLaSsIaN.NeT/  ']) {
    assert.equal(normaliseSite(input), 'https://name.atlassian.net');
  }
  for (const input of [
    'atlassian.net.evil.com',
    'name.atlassian.net:443',
    'name.atlassian.net/x',
    'user@name.atlassian.net',
    'xn--name.atlassian.net',
    'name.atlassian.net.',
  ]) {
    assert.equal(normaliseSite(input), null, input);
  }
});
