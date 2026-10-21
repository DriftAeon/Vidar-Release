// Shared browser shell (src/browser/shell.ts) under jsdom with a fake adapter: the Esc order, activate()
// short-circuiting the card, skipped key targets, menu dismissal, the "" band, and RenderCtx.alive().
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

const PREFS = `const s = (globalThis.__prefs ??= { store: {}, sets: [] });
  export function getPref(k) { return s.store[k]; }
  export function setPref(k, v) { s.sets.push([k, v]); s.store[k] = v; return true; }`;
const { window, observers, ledger, flush } = setupDom({ stubs: { prefs: PREFS } });
const { buildBrowser } = await import('../src/browser/shell.ts');

const g = (id, label, rank, tone = 'neutral') => ({ id, label, rank, tone });
const item = (id, group, extra = {}) => ({
  id, key: id.toUpperCase(), title: `Title ${id}`, status: group ? group.label : '', updated: '2026-10-17T10:00:00Z',
  group, facets: { status: [group ? group.label : ''] }, fields: [{ label: 'Edited', value: '2h' }], ...extra,
});
const FACETS = [{ id: 'status', label: 'Status', place: 'top', kind: 'multi', valueLabel: (v) => v || 'None' }];

function fake(over = {}) {
  const log = [];
  const ctxs = [];
  const sub = item('sub', undefined);
  const adapter = {
    source: 'test:one', noun: 'Pages',
    rich: {
      render(doc, ctx) { ctxs.push(ctx); const el = document.createElement('div'); el.textContent = String(doc); return { el, fellBack: false }; },
      excerpt: () => '',
    },
    load: async (it) => ({ ok: {
      extraFields: [], excerpt: `Excerpt ${it.id}`, body: `Body ${it.id}`,
      sections: [{ title: 'Subpages', rows: [{ item: sub }] }], comments: { total: 0, items: [], more: false },
    } }),
    moreComments: async () => ({ ok: { total: 0, items: [], more: false } }),
    send: (it) => log.push(['send', it.id]),
    open: (it) => log.push(['open', it.id]),
    openUrl: (u) => log.push(['openUrl', u]),
    back: () => log.push(['back']),
    ...over,
  };
  return { adapter, log, ctxs };
}

function mount(adapter, items = [item('a', g('p', 'In Progress', 0, 'progress')), item('b', g('p', 'In Progress', 0, 'progress'))]) {
  const head = document.createElement('div');
  head.appendChild(document.createElement('span'));
  const b = buildBrowser(adapter, head);
  document.body.appendChild(b.root);
  b.setItems(items, FACETS, { busy: false, note: null });
  return b;
}

const key = (target, k) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const rowsOf = (b) => [...b.root.querySelectorAll('.br-list .br-row')];
const menu = () => document.querySelector('.br-menu');
const openStatusMenu = (b) => b.root.querySelector('.br-chip-btn[data-facet="status"]').click();

test('Esc closes menu, then fullscreen, then card, then calls back', async () => {
  const { adapter, log } = fake();
  const b = mount(adapter);
  const row = rowsOf(b)[0];
  key(row, 'Enter');
  assert.ok(b.root.querySelector('.br-card'), 'Enter expands the card');
  b.root.querySelector('.br-card button[aria-label="Fullscreen"]').click();
  await flush();
  assert.ok(b.root.querySelector('.br-full'), 'fullscreen open');
  openStatusMenu(b); // the filter row is hidden in fullscreen, but a menu still closes first
  assert.ok(menu(), 'menu open');
  key(b.root.querySelector('.br-full'), 'Escape');
  assert.equal(menu(), null, 'first Esc: menu');
  assert.ok(b.root.querySelector('.br-full'));
  key(b.root.querySelector('.br-full'), 'Escape');
  assert.equal(b.root.querySelector('.br-full'), null, 'second Esc: fullscreen');
  assert.ok(b.root.querySelector('.br-card'), 'the card stays open behind fullscreen');
  assert.equal(document.activeElement?.dataset.id, 'a', 'focus returns to the row');
  key(document.activeElement, 'Escape');
  assert.equal(b.root.querySelector('.br-card'), null, 'third Esc: card');
  assert.deepEqual(log, []);
  key(rowsOf(b)[0], 'Escape');
  assert.deepEqual(log, [['back']], 'fourth Esc: adapter.back');
  b.dispose();
  b.root.remove();
});

test('a row tip and the adapter sendTip reach the DOM', () => {
  const { adapter } = fake({ sendTip: 'Sends it somewhere.' });
  const b = mount(adapter, [item('a', undefined, { tip: 'Opens the thing.' }), item('b', undefined)]);
  const [a, c] = rowsOf(b);
  assert.equal(a.title, 'Opens the thing.');
  assert.equal(c.title, '');
  assert.equal(a.querySelector('.br-send').title, 'Sends it somewhere.');
  assert.equal(c.querySelector('.br-send').title, 'Sends it somewhere.');
  b.dispose();
  b.root.remove();
});

test('activate returning true skips the card; false falls through', () => {
  const seen = [];
  let handled = true;
  const { adapter } = fake({ activate: (it) => { seen.push(it.id); return handled; } });
  const b = mount(adapter);
  rowsOf(b)[0].click();
  key(rowsOf(b)[1], ' ');
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(b.root.querySelector('.br-card'), null);
  handled = false;
  key(rowsOf(b)[0], 'Enter');
  assert.ok(b.root.querySelector('.br-card'));
  b.dispose();
  b.root.remove();
});

test('input and non-row button targets are skipped', () => {
  const { adapter, log } = fake();
  const b = mount(adapter);
  const search = b.root.querySelector('input.br-search-q');
  key(search, 'Enter');
  key(search, 'ArrowDown');
  key(search, 'Escape');
  const send = rowsOf(b)[0].querySelector('button.br-send');
  key(send, 'Enter');
  key(send, ' ');
  assert.equal(b.root.querySelector('.br-card'), null, 'no card from a field or a button');
  assert.deepEqual(log, [], 'Esc in a field never reaches back');
  assert.notEqual(document.activeElement?.classList.contains('br-row'), true, 'ArrowDown in a field moves no row focus');
  send.click();
  assert.deepEqual(log, [['send', 'a']], 'the button keeps its own click');
  assert.equal(b.root.querySelector('.br-card'), null, 'Send does not toggle the card');
  b.dispose();
  b.root.remove();
});

test('menus close on outside pointerdown, resize, root resize or hide, and dispose', () => {
  const { adapter } = fake();
  const b = mount(adapter);
  const before = ledger.count();
  openStatusMenu(b);
  assert.ok(ledger.count() > before, 'listeners only while open');
  const m = menu();
  assert.ok(m);
  assert.equal(m.parentElement, document.body, 'fixed on body');
  m.querySelector('button.br-mi').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.ok(menu(), 'a press inside keeps it');
  document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(menu(), null, 'outside pointerdown');
  openStatusMenu(b);
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(menu(), null, 'window resize');
  openStatusMenu(b);
  const ro = observers.at(-1);
  ro.cb([]);
  assert.equal(menu(), null, 'root resized or hidden (tab switch, module hide)');
  openStatusMenu(b);
  b.dispose();
  assert.equal(menu(), null, 'dispose');
  assert.equal(ro.disconnected, true);
  assert.equal(ledger.count(), before, 'no window or document listener left');
  b.root.remove();
});

test('a value toggled in the menu filters, persists through cleanFilters, and Esc in the menu closes it', () => {
  const { adapter } = fake();
  globalThis.__prefs.sets.length = 0;
  const b = mount(adapter, [item('a', g('p', 'In Progress', 0, 'progress')), item('b', g('t', 'To Do', 1, 'todo'))]);
  openStatusMenu(b);
  const todo = [...menu().querySelectorAll('button.br-mi')].find((x) => x.textContent.startsWith('To Do'));
  todo.click();
  assert.deepEqual(rowsOf(b).map((r) => r.dataset.id), ['b']);
  assert.equal(b.root.querySelector('.br-count'), null);
  assert.deepEqual(globalThis.__prefs.sets.at(-1), ['browser.filters', { 'test:one': { status: ['To Do'] } }]);
  key(menu().querySelector('button.br-mi'), 'Escape');
  assert.equal(menu(), null);
  b.dispose();
  b.root.remove();
  globalThis.__prefs.store = {};
});

test('a band labelled "" draws nothing; empty key and status draw no span or pill', () => {
  const { adapter } = fake();
  const b = mount(adapter, [item('a', g('p', 'In Progress', 0, 'progress')), item('b', undefined, { key: '' })]);
  const bands = [...b.root.querySelectorAll('.br-band')];
  assert.deepEqual(bands.map((x) => x.querySelector('.br-band-label').textContent), ['In Progress']);
  assert.ok(bands[0].classList.contains('tone-progress'));
  const flat = rowsOf(b)[1];
  assert.equal(flat.querySelector('.br-key'), null);
  assert.equal(flat.querySelector('.br-pill'), null);
  b.setItems([item('c', undefined), item('d', undefined)], FACETS, { busy: false, note: null });
  assert.equal(b.root.querySelectorAll('.br-band').length, 0);
  assert.equal(rowsOf(b).length, 2);
  b.dispose();
  b.root.remove();
});

test('ctx.alive() goes false when the fullscreen item changes and on dispose; loadChildren falls back', async () => {
  const { adapter, ctxs } = fake();
  const b = mount(adapter);
  key(rowsOf(b)[0], 'Enter');
  b.root.querySelector('.br-card button[aria-label="Fullscreen"]').click();
  await flush();
  assert.equal(ctxs.length, 1);
  const first = ctxs[0];
  assert.equal(first.alive(), true);
  const r = await first.loadChildren('x', null);
  assert.ok('error' in r, 'no Adapter.loadChildren: ctx answers an error');
  first.openUrl('https://example.com/');
  b.root.querySelector('.br-full .br-row').click(); // a section row replaces the page
  await flush();
  assert.equal(first.alive(), false, 'item changed');
  const second = ctxs.at(-1);
  assert.equal(second.alive(), true);
  b.dispose();
  assert.equal(second.alive(), false, 'disposed');
  b.root.remove();
});

test('reset closes fullscreen, collapses the card, drops built cards and ends every ctx; so does an adapter generation move', async () => {
  let gen = 0;
  let loads = 0;
  const { adapter, ctxs } = fake({ generation: () => gen });
  const load = adapter.load;
  adapter.load = (it) => { loads++; return load(it); };
  const b = mount(adapter);
  key(rowsOf(b)[0], 'Enter');
  b.root.querySelector('.br-card button[aria-label="Fullscreen"]').click();
  await flush();
  const ctx = ctxs.at(-1);
  assert.equal(ctx.alive(), true);
  b.reset();
  assert.equal(ctx.alive(), false, 'a walk in flight stops');
  assert.equal(b.root.querySelector('.br-full-host').hidden, true, 'fullscreen closed');
  assert.equal(b.root.querySelector('.br-card'), null, 'card collapsed');
  const before = loads;
  key(rowsOf(b)[0], 'Enter');
  await flush();
  assert.equal(loads, before + 1, 'the card is built afresh, not the old one');
  b.root.querySelector('.br-card button[aria-label="Fullscreen"]').click();
  await flush();
  const next = ctxs.at(-1);
  assert.equal(next.alive(), true);
  gen++;
  assert.equal(next.alive(), false, 'the source generation moved');
  b.dispose();
  b.root.remove();
});
