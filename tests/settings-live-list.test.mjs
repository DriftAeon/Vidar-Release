// Settings live lists: a redraw keeps focus, caret and typed text; a pending focus lands on the draw that wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

setupDom({ stubs: {} });
const { liveList, redraw, refreshLive, focusOnNextDraw, isRedrawing } = await import('../src/settings/live-list.ts');

const flush = () => new Promise((r) => setTimeout(r, 0));

function rows(root, values, onChange) {
  for (const v of values) {
    const row = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = v;
    input.defaultValue = v;
    input.addEventListener('change', () => { if (!isRedrawing()) onChange?.(input.value); });
    const btn = document.createElement('button');
    row.append(input, btn);
    root.appendChild(row);
  }
}

test('redraw keeps focus, caret and dirty text', () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  rows(root, ['a', 'b']);
  const old = root.children[1].querySelector('input');
  old.focus();
  old.value = 'bxyz';
  old.setSelectionRange(2, 3);
  redraw(root, () => { root.replaceChildren(); rows(root, ['a', 'b']); });
  const now = root.children[1].querySelector('input');
  assert.notEqual(now, old);
  assert.equal(document.activeElement, now);
  assert.equal(now.value, 'bxyz');
  assert.equal(now.selectionStart, 2);
  assert.equal(now.selectionEnd, 3);
  root.remove();
});

test('a changed default drops the typed text instead of moving it', () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  rows(root, ['a', 'b']);
  const old = root.children[1].querySelector('input');
  old.focus();
  old.value = 'typed';
  redraw(root, () => { root.replaceChildren(); rows(root, ['a', 'c']); });
  const now = root.children[1].querySelector('input');
  assert.equal(document.activeElement, now);
  assert.equal(now.value, 'c');
  root.remove();
});

test('a change during the redraw is not a commit', () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const seen = [];
  rows(root, ['a'], (v) => seen.push(v));
  const flags = [];
  redraw(root, () => {
    flags.push(isRedrawing());
    rows(root, ['a'], (v) => seen.push(v));
    const input = root.querySelector('input');
    input.value = 'edited';
    input.dispatchEvent(new window.Event('change'));
  });
  flags.push(isRedrawing());
  assert.deepEqual(flags, [true, false]);
  assert.deepEqual(seen, []);
  root.remove();
});

test('focusOnNextDraw lands on the draw that wins under the latest-wins check', async () => {
  const reads = [];
  const read = () => new Promise((res) => reads.push(res));
  const drawn = [];
  const live = new Set();
  const root = liveList(live, read, (r, s) => {
    drawn.push(s);
    rows(r, [s]);
    const t = document.createElement('input');
    t.className = 'target';
    r.appendChild(t);
  });
  document.body.appendChild(root);
  refreshLive(live); // supersedes the first read
  focusOnNextDraw(root, '.target');
  reads[0]('stale'); // superseded: no draw, the pending focus stays
  await flush();
  assert.deepEqual(drawn, []);
  assert.notEqual(document.activeElement?.className, 'target');
  reads[1]('fresh');
  await flush();
  assert.deepEqual(drawn, ['fresh']);
  assert.equal(document.activeElement, root.querySelector('.target'));
  root.remove();
});
