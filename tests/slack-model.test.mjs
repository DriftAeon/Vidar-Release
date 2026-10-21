import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ITEM_KEYS, initial, isNewer, laterTs, looksLikeUserToken, newestTs, placeOf, sections, sendText, whenIso } from '../src/slack/model.ts';
import { SLACK_MANIFEST } from '../src/slack/manifest.ts';
import { parseWhen } from '../src/browser/when.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/slack/items.json', import.meta.url), 'utf8'));

test('items fixture keys match the model key list, in order', () => {
  assert.ok(fixture.items.length > 0);
  for (const item of fixture.items) assert.deepEqual(Object.keys(item), [...ITEM_KEYS]);
});

test('sections put DMs flat first and channels by newest message, with the place fallback', () => {
  const it = (id, place, channel, ts) => ({ id: `${id}:${ts}`, kind: 'mention', place, sender: 's', channel, text: '', ts, url: '' });
  const out = sections([
    it('C1', 'channel', '#a', '10.000001'),
    it('C2', 'private', '#b', '30.000001'),
    it('C1', 'channel', '#a', '20.000001'),
    it('D1', 'dm', 'DM', '5.000001'),
    { ...it('G1', undefined, 'Group DM', '6.000001') },
  ]);
  assert.deepEqual(out.dms.map((i) => i.ts), ['6.000001', '5.000001']);
  assert.deepEqual(out.channels.map((c) => [c.id, c.name, c.private, c.items.map((i) => i.ts)]), [
    ['C2', 'b', true, ['30.000001']],
    ['C1', 'a', false, ['20.000001', '10.000001']],
  ]);
  assert.equal(placeOf({ channel: 'DM' }), 'dm');
  assert.equal(placeOf({ channel: 'Group DM' }), 'group');
  assert.equal(placeOf({ channel: '#x' }), 'channel');
  assert.equal(placeOf({ channel: '#x', place: 'private' }), 'private');
});

test('isNewer compares secs then micros as numbers; no seen means nothing is new', () => {
  assert.equal(isNewer('100.000200', '100.000100'), true);
  assert.equal(isNewer('100.000100', '100.000200'), false);
  assert.equal(isNewer('100.000100', '100.000100'), false);
  assert.equal(isNewer('101.000001', '100.999999'), true);
  assert.equal(isNewer('9.000001', '10.000001'), false);
  assert.equal(isNewer('100.000100', null), false);
  assert.equal(isNewer('100.000100', 'junk'), false);
  assert.equal(newestTs([{ ts: '9.000001' }, { ts: '10.000001' }, { ts: 'x' }]), '10.000001');
  assert.equal(laterTs('10.000001', '9.000001'), '10.000001');
  assert.equal(laterTs(undefined, '9.000001'), '9.000001');
});

test('initial takes one code point', () => {
  assert.equal(initial('ada'), 'A');
  assert.equal(initial('  😀 x'), '😀');
  assert.equal(initial(''), '');
});

test('send text collapses whitespace, strips Cc/Cf/Zl/Zp and adds no second #', () => {
  const out = sendText({ sender: 'bo‮', channel: '#ops', text: 'a \t\n  b​ c\r\n' });
  assert.equal(out, '@bo in #ops: a b c');
  assert.doesNotMatch(out, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  assert.ok(!out.includes('##'));
  const dm = sendText(fixture.items[0]);
  assert.equal(dm, '@Ada Example in DM: lunch?');
  assert.equal(sendText(fixture.items[3]).startsWith('@Ada Example in #general: '), true);
  assert.ok(!sendText(fixture.items[3]).includes('slack.com'));
});

test('send text caps at 1024 bytes on a code-point boundary', () => {
  const big = sendText({ sender: 'a', channel: 'DM', text: '😀'.repeat(400) });
  assert.ok(new TextEncoder().encode(big).length <= 1024);
  assert.ok(!big.includes('�'));
});

test('whenIso round-trips a fixture ts', () => {
  const ts = fixture.items[0].ts;
  const iso = whenIso(ts);
  assert.equal(iso, new Date(Math.floor(Number(ts)) * 1000).toISOString());
  assert.equal(parseWhen(iso), Math.floor(Number(ts)) * 1000);
  assert.equal(whenIso('nope'), '');
});

test('looksLikeUserToken checks xoxp-', () => {
  assert.equal(looksLikeUserToken('xoxp-123'), true);
  assert.equal(looksLikeUserToken('xoxb-123'), false);
  assert.equal(looksLikeUserToken(''), false);
});

test('manifest is JSON with exactly the two user scopes', () => {
  const m = JSON.parse(SLACK_MANIFEST);
  assert.deepEqual(m.oauth_config.scopes.user, ['search:read', 'users:read']);
  assert.equal(m.display_information.name, 'Vidar Inbox');
  assert.equal(SLACK_MANIFEST, JSON.stringify(m, null, 2));
});
