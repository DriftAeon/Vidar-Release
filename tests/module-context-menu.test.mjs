import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

const { window, ledger } = setupDom();
const { bindModuleContextMenu, openModuleContextMenu } = await import('../src/modules/context-menu.ts');

function fixture(actions = [{ label: 'Hide Tray', onSelect() {} }]) {
  const anchor = document.createElement('button');
  anchor.textContent = 'Tray';
  document.body.append(anchor);
  const dispose = bindModuleContextMenu(anchor, () => actions);
  return { anchor, dispose: () => { dispose(); anchor.remove(); } };
}

const menu = () => document.querySelector('.module-context-menu');
const item = () => menu()?.querySelector('[role="menuitem"]');

test('right click opens a body menu and choosing Hide restores trigger focus', () => {
  let calls = 0;
  const f = fixture([{ label: 'Hide Tray', onSelect: () => { calls++; } }]);
  try {
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 31, clientY: 43 });
    f.anchor.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(menu().parentElement, document.body);
    assert.equal(menu().getAttribute('role'), 'menu');
    assert.equal(f.anchor.getAttribute('aria-expanded'), 'true');
    assert.equal(menu().style.left, '31px');
    assert.equal(menu().style.top, '43px');
    assert.equal(document.activeElement, item());
    item().click();
    assert.equal(calls, 1);
    assert.equal(menu(), null);
    assert.equal(f.anchor.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, f.anchor);
  } finally { f.dispose(); }
});

test('Hide that removes the anchor moves focus to a surviving control in its container', () => {
  const strip = document.createElement('div');
  const a = document.createElement('button');
  const b = document.createElement('button');
  const c = document.createElement('button');
  strip.append(a, b, c);
  document.body.append(strip);
  const dispose = bindModuleContextMenu(b, () => [{ label: 'Hide B', kind: 'hide', onSelect: () => b.remove() }]);
  try {
    b.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    item().click();
    assert.equal(menu(), null);
    assert.equal(b.isConnected, false);
    assert.notEqual(document.activeElement, document.body);
    assert.equal(document.activeElement, a);
  } finally { dispose(); strip.remove(); }
});

test('Hide that empties the container focuses the container itself', () => {
  const strip = document.createElement('div');
  const only = document.createElement('button');
  strip.append(only);
  document.body.append(strip);
  const dispose = bindModuleContextMenu(only, () => [{ label: 'Hide Only', kind: 'hide', onSelect: () => only.remove() }]);
  try {
    only.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    item().click();
    assert.equal(document.activeElement, strip);
  } finally { dispose(); strip.remove(); }
});

test('Hide that removes the container focuses its nearest connected ancestor', () => {
  const outer = document.createElement('div');
  const parent = document.createElement('div');
  const strip = document.createElement('div');
  const only = document.createElement('button');
  strip.append(only);
  parent.append(strip);
  outer.append(parent);
  document.body.append(outer);
  const dispose = bindModuleContextMenu(only, () => [{ label: 'Hide Only', kind: 'hide', onSelect: () => strip.remove() }]);
  try {
    only.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    item().click();
    assert.equal(strip.isConnected, false);
    assert.equal(document.activeElement, parent);
  } finally { dispose(); outer.remove(); }
});

test('Context Menu key and Shift+F10 open from the keyboard anchor', () => {
  const f = fixture();
  try {
    for (const [key, shiftKey] of [['ContextMenu', false], ['F10', true]]) {
      f.anchor.focus();
      const event = new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
      f.anchor.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
      assert.equal(document.activeElement, item());
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert.equal(document.activeElement, f.anchor);
    }
  } finally { f.dispose(); }
});

test('core Hide is announced as disabled and cannot act', () => {
  let calls = 0;
  const f = fixture([{ label: 'Hide Relay', kind: 'hide', level: 'core', onSelect: () => { calls++; } }]);
  try {
    f.anchor.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    assert.equal(item().getAttribute('aria-disabled'), 'true');
    assert.equal(item().getAttribute('aria-description'), 'Core Module Always Shown');
    assert.equal(document.activeElement, item(), 'disabled row remains keyboard focusable');
    item().click();
    assert.equal(calls, 0);
    assert.ok(menu(), 'disabled click does not dismiss menu');
  } finally { f.dispose(); }
});

test('Escape restores focus; outside click and focus departure close', () => {
  const f = fixture();
  const outside = document.createElement('button');
  document.body.append(outside);
  try {
    f.anchor.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(menu(), null);
    assert.equal(document.activeElement, f.anchor);

    f.anchor.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    outside.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(menu(), null);
    assert.equal(document.activeElement, f.anchor);

    f.anchor.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    outside.focus();
    assert.equal(menu(), null);
    assert.equal(document.activeElement, outside);
  } finally { f.dispose(); outside.remove(); }
});

test('repeated opens keep one set of document listeners and dispose removes them', () => {
  const f = fixture();
  const initial = ledger.types();
  try {
    for (let i = 0; i < 5; i++) {
      f.anchor.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      assert.deepEqual(ledger.types().filter((type) => ['click', 'focusin', 'keydown'].includes(type)).sort(),
        [...initial.filter((type) => ['click', 'focusin', 'keydown'].includes(type)), 'click', 'focusin', 'keydown'].sort());
    }
    const second = document.createElement('button');
    document.body.append(second);
    const next = openModuleContextMenu(second, [{ label: 'Show Tray', onSelect() {} }]);
    assert.equal(document.querySelectorAll('.module-context-menu').length, 1);
    next.close();
    second.remove();
    assert.deepEqual(ledger.types(), initial);
  } finally { f.dispose(); }
  assert.deepEqual(ledger.types(), initial);
});
