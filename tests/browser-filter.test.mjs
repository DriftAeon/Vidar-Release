import test from 'node:test';
import assert from 'node:assert/strict';
import {
  facetCounts, filterItems, cleanFilters, writeSource, ageBucket, MAX_FILTER_BYTES,
} from '../src/browser/filter.ts';
import { parseWhen, relativeTime, absoluteTime } from '../src/browser/when.ts';
import { cleanSend } from '../src/browser/send.ts';
import { safeUrl, inertLink } from '../src/browser/rich.ts';
import { PrefsStore, GUARDS } from '../src/prefs-core.ts';

const item = (id, title, facets) => ({ id, key: '', title, status: '', updated: '', facets, fields: [] });
const multi = (id) => ({ id, label: id, place: 'top', kind: 'multi', valueLabel: (v) => v });
const env = { now: Date.UTC(2026, 9, 17, 12), parse: parseWhen };
const items = [
  item('1', 'Alpha plan', { st: ['Open'], who: ['ann'] }),
  item('2', 'Beta plan', { st: ['Open'], who: ['bob'] }),
  item('3', 'Gamma', { st: ['Done'], who: ['ann', 'bob'] }),
];
const facets = [multi('st'), multi('who')];

test('OR within a facet, AND across facets', () => {
  const ids = (sel, q = '') => filterItems(items, facets, sel, q, env).map((i) => i.id);
  assert.deepEqual(ids({ st: ['Open', 'Done'] }), ['1', '2', '3']);
  assert.deepEqual(ids({ st: ['Open'], who: ['bob'] }), ['2']);
  assert.deepEqual(ids({ who: ['ann', 'bob'] }), ['1', '2', '3']);
  assert.deepEqual(ids({}, 'PLAN'), ['1', '2']);
  assert.deepEqual(ids({ st: ['Open'] }, 'gamma'), []);
});

test('counts apply the other facets and search but not their own', () => {
  const c = facetCounts(items, facets, { st: ['Done'], who: ['bob'] }, '', env);
  assert.deepEqual([...c.st], [['Open', 1], ['Done', 1]]);
  assert.deepEqual([...c.who], [['ann', 1], ['bob', 1]]);
  const s = facetCounts(items, facets, {}, 'plan', env);
  assert.deepEqual([...s.st], [['Open', 2]]);
});

test('a selected value missing from the set stays with count 0', () => {
  const c = facetCounts(items, facets, { st: ['Gone'] }, '', env);
  assert.equal(c.st.get('Gone'), 0);
});

test('age facets bucket an ISO timestamp', () => {
  assert.equal(ageBucket(env.now - 3600000, env.now), '1d');
  assert.equal(ageBucket(env.now - 3 * 86400000, env.now), '7d');
  assert.equal(ageBucket(env.now - 20 * 86400000, env.now), '30d');
  assert.equal(ageBucket(env.now - 90 * 86400000, env.now), 'older');
  assert.equal(ageBucket(null, env.now), 'none');
  const age = { id: 'ed', label: 'Edited', place: 'more', kind: 'age', valueLabel: (v) => v };
  const rows = [item('a', 'a', { ed: ['2026-10-17T11:00:00Z'] }), item('b', 'b', { ed: ['2025-01-01T00:00:00Z'] })];
  assert.deepEqual(filterItems(rows, [age], { ed: ['1d'] }, '', env).map((i) => i.id), ['a']);
  assert.deepEqual([...facetCounts(rows, [age], {}, '', env).ed], [['1d', 1], ['older', 1]]);
});

test('cleanFilters: a bad facet drops alone, wrong shapes read empty', () => {
  const out = cleanFilters({
    s: { good: ['a'], notArray: 'x', mixed: ['a', 1], long: ['x'.repeat(81)], many: Array(33).fill('v'), empty: [] },
    bad: 'nope',
  });
  assert.deepEqual(out, { s: { good: ['a'] } });
  assert.deepEqual(cleanFilters(null), {});
  assert.deepEqual(cleanFilters([1]), {});
  assert.deepEqual(cleanFilters(JSON.parse('{"__proto__":{"a":["b"]}}')), JSON.parse('{"__proto__":{"a":["b"]}}'));
});

test('cleanFilters bounds: 12 facets, 50 sources (oldest drop), 64 KB', () => {
  const facets13 = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, ['v']]));
  assert.equal(Object.keys(cleanFilters({ s: facets13 }).s).length, 12);

  const many = Object.fromEntries(Array.from({ length: 52 }, (_, i) => [`s${i}`, { f: ['v'] }]));
  const kept = Object.keys(cleanFilters(many));
  assert.equal(kept.length, 50);
  assert.equal(kept[0], 's2');
  assert.equal(kept.at(-1), 's51');

  const fat = {};
  for (let s = 0; s < 40; s++) {
    fat[`src${s}`] = Object.fromEntries(Array.from({ length: 12 }, (_, f) => [`f${f}`, Array.from({ length: 32 }, (_, v) => `${'x'.repeat(70)}${s}-${f}-${v}`.slice(-80))]));
  }
  const capped = cleanFilters(fat);
  assert.ok(new TextEncoder().encode(JSON.stringify(capped)).length <= MAX_FILTER_BYTES);
  const keys = Object.keys(capped);
  assert.ok(keys.length > 0 && keys.length < 40);
  assert.equal(keys.at(-1), 'src39');
});

test('writeSource moves the written source to the newest slot', () => {
  const out = writeSource({ a: { f: ['1'] }, b: { f: ['2'] } }, 'a', { f: ['3'] });
  assert.deepEqual(Object.keys(out), ['b', 'a']);
  assert.deepEqual(Object.keys(writeSource(out, 'a', {})), ['b']);
});

test('browser.filters pref: guard checks shape only; the shell cleans', async () => {
  const g = GUARDS['browser.filters'];
  assert.equal(g({ s: { f: ['a'] } }), true);
  assert.equal(g({ s: { f: 'a' } }), false);
  assert.equal(g({ s: 'a' }), false);
  assert.equal(g([]), false);
  assert.equal(g({ s: { f: Array(40).fill('a') } }), true);
  const store = new PrefsStore({ read: async () => ({ 'browser.filters': { s: { good: ['a'], big: Array(40).fill('v') } }, }), patch: async () => ({}) });
  await store.init();
  // The store hands the value back as stored; cleanFilters on read drops the over-long facet.
  assert.equal(store.get('browser.filters').s.big.length, 40);
  assert.deepEqual(cleanFilters(store.get('browser.filters')), { s: { good: ['a'] } });
  // Write path: writeSource then cleanFilters, then the store round-trips it.
  const next = cleanFilters(writeSource(store.get('browser.filters'), 't', { f: ['1'], big: Array(40).fill('v') }));
  assert.deepEqual(next, { s: { good: ['a'] }, t: { f: ['1'] } });
  store.set('browser.filters', next);
  assert.deepEqual(store.get('browser.filters'), next);
});

test('when: offsets parse explicitly, colon or not', () => {
  const z = Date.UTC(2026, 9, 12, 10, 0, 0);
  assert.equal(parseWhen('2026-10-12T10:00:00.000Z'), z);
  assert.equal(parseWhen('2026-10-12T11:00:00.000+0100'), z);
  assert.equal(parseWhen('2026-10-12T11:00:00+01:00'), z);
  assert.equal(parseWhen('2026-10-12T05:30:00-0430'), z);
  assert.equal(parseWhen('2026-10-12'), Date.UTC(2026, 9, 12));
  assert.equal(parseWhen('2026-13-12'), null);
  assert.equal(parseWhen('nope'), null);
  assert.equal(relativeTime('nope'), '');
  assert.equal(absoluteTime('nope'), '');
});

test('when: relative labels', () => {
  const now = new Date(2026, 9, 17, 12, 0).getTime();
  const iso = (d) => new Date(d).toISOString();
  assert.equal(relativeTime(iso(now - 30000), now), 'Now');
  assert.equal(relativeTime(iso(now - 5 * 60000), now), '5m');
  assert.equal(relativeTime(iso(now - 2 * 3600000), now), '2h');
  assert.equal(relativeTime(iso(new Date(2026, 9, 16, 9, 0).getTime()), now), 'Yesterday');
  assert.equal(relativeTime(iso(new Date(2026, 9, 12, 9, 0).getTime()), now), 'Oct 12');
  assert.equal(relativeTime(iso(new Date(2025, 9, 12, 9, 0).getTime()), now), 'Oct 12, 2025');
  assert.equal(absoluteTime(iso(new Date(2026, 9, 12, 14, 5).getTime())), 'Oct 12, 2026, 14:05');
});

test('cleanSend strips control, format and separator characters and caps on a code point', () => {
  assert.equal(cleanSend('a‮b​c d\re\nf\tg﻿', 100), 'abcdefg');
  const big = cleanSend('😀'.repeat(300), 1023);
  assert.equal(big, '😀'.repeat(255));
  assert.equal(new TextEncoder().encode(big).length, 1020);
  assert.equal(cleanSend('abc', 2), 'ab');
});

test('inertLink refuses non-http(s) URLs and never sets an href', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
  assert.equal(safeUrl('/relative'), null);
  assert.equal(safeUrl('https://example.com/a b'), null);
  assert.equal(safeUrl('https://example.com'), 'https://example.com/');

  const made = () => {
    const n = { cls: '', attrs: {}, listeners: {}, textContent: '', tabIndex: -1 };
    n.setAttribute = (k, v) => { n.attrs[k] = v; };
    n.addEventListener = (t, f) => { n.listeners[t] = f; };
    Object.defineProperty(n, 'className', { set: (v) => { n.cls = v; }, get: () => n.cls });
    return n;
  };
  globalThis.document = { createElement: () => made() };
  try {
    const opened = [];
    const bad = inertLink('x', 'javascript:alert(1)', (u) => opened.push(u));
    assert.deepEqual(Object.keys(bad.listeners), []);
    assert.equal('href' in bad.attrs, false);
    const ok = inertLink('x', 'https://example.com/p', (u) => opened.push(u));
    assert.equal('href' in ok.attrs, false);
    ok.listeners.click({ preventDefault() {} });
    assert.deepEqual(opened, ['https://example.com/p']);
  } finally {
    delete globalThis.document;
  }
});
