// Settings > Modules: exercise the registered control and its persisted, live state.
// jsdom stands in for WebView2; the save stub controls patch completion explicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

const state = {
  prefs: new Map(),
  saves: [],
  subscriber: null,
  session: null,
  unlisted: new Set(),
  disk: {},
  writes: [],
  gate: null,
};
globalThis.__moduleSettingsTest = state;

setupDom({
  stubs: {
    prefs: `const s = globalThis.__moduleSettingsTest;
      export function getPref(key) { return s.prefs.get(key); }
      export function setPref(key, value) { s.prefs.set(key, value); return true; }
      export function savePrefConfirmed(key, value) {
        s.prefs.set(key, value);
        return new Promise((resolve) => s.saves.push({ key, value, resolve(outcome) {
          if (outcome.status === 'failed') s.subscriber?.([key], new Error('refused'));
          resolve(outcome);
        } }));
      }
      export function onPrefsError(cb) { s.subscriber = cb; }`,
    'panels/press': 'export function repeatPress() {}',    'panels/workbench': 'export function setWorkbenchTabVisibility() {}',
    'panels/toolbench': 'export function setToolVisibility() {} export function syncToolOrder() {}',
    'modules/registry': `export const moduleOn = () => true; export const onModulesChange = () => () => {};
      export const moduleListed = (id) => !globalThis.__moduleSettingsTest.unlisted.has(id);`,
    'panels/sessions':'export function getFocusedSession() { return globalThis.__moduleSettingsTest.session; }',
    'tools/registry': `export const BUILTIN_TOOL_MODULES = [
      { id: 'marquee', label: 'Marquee Read Text', level: 'optional' },
      { id: 'eyedropper', label: 'Eyedropper', level: 'optional' },
    ];`,
  },
  answers: {
    // vidar.json moduleNames for the real src/modules/names.ts store; `gate` holds patches open.
    read_config: () => ({ config: { moduleNames: structuredClone(state.disk) }, error: null, notice: null }),
    patch_settings: async ({ key, value }) => {
      assert.equal(key, 'moduleNames');
      state.writes.push(value);
      if (state.gate) await state.gate;
      state.disk = structuredClone(value);
    },
    read_mcp_servers: {
      servers: [
        { name: 'alpha', scope: 'user', transport: 'stdio', target: 'alpha', args: [], envKeys: [], project: null },
        { name: 'beta', scope: 'project', transport: 'stdio', target: 'beta', args: [], envKeys: [], project: 'C:\\project' },
      ],
      notes: [],
    },
  },
});
// Node's own CustomEvent is not a jsdom Event and cannot dispatch on document.
globalThis.CustomEvent = window.CustomEvent;

const { registerModuleRows } = await import('../src/settings/modules.ts');
const { categoryList, getSettingRows } = await import('../src/settings/registry.ts');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const control = () => {
  const row = getSettingRows().find((r) => r.category === 'modules');
  assert.ok(row, 'Modules setting row was not registered');
  const root = row.control(() => {});
  document.body.replaceChildren(root);
  return root;
};
const section = (root, key) => {
  const el = root.querySelector(`[data-order-key="${key}"]`);
  assert.ok(el, `${key} list missing`);
  return el;
};
const row = (root, id) => {
  const el = root.querySelector(`[data-module-id="${id}"]`);
  assert.ok(el, `${id} row missing`);
  return el;
};
const toggle = (root, id) => {
  const el = row(root, id).querySelector('[role="switch"]');
  assert.ok(el, `${id} switch missing`);
  return el;
};
const status = (root) => root.querySelector('[data-module-save-status]')?.textContent?.trim();
const savedKeys = (key) => state.prefs.get(key) ?? [];
const settle = async (outcome) => {
  const save = state.saves.shift();
  assert.ok(save, 'no pending patch');
  save.resolve(outcome);
  await tick();
  return save;
};

test('Modules category registers once and renders its three groups', () => {
  registerModuleRows();
  registerModuleRows();
  assert.ok(categoryList().some(([id, label]) => id === 'modules' && label === 'Modules'));
  assert.equal(getSettingRows().filter((r) => r.category === 'modules').length, 1);
  const root = control();
  assert.deepEqual([...root.querySelectorAll('[data-order-key]')].map((s) => s.dataset.orderKey),
    ['order.workbenchTabs', 'order.tools', 'order.rack']);
});

test('a release set without Lab or Eyedropper lists no row for them', () => {
  const ids = (root, key) => [...section(root, key).querySelectorAll('[data-module-id]')].map((el) => el.dataset.moduleId);
  const all = control();
  assert.ok(ids(all, 'order.workbenchTabs').includes('bench:lab'), 'every id listed: the row shows');
  assert.ok(ids(all, 'order.tools').includes('tool:eyedropper'));
  state.unlisted = new Set(['lab', 'eyedropper']);
  try {
    const root = control();
    assert.ok(!ids(root, 'order.workbenchTabs').includes('bench:lab'));
    assert.ok(ids(root, 'order.workbenchTabs').includes('bench:runelib'));
    assert.deepEqual(ids(root, 'order.tools'), ['tool:marquee']);
  } finally {
    state.unlisted = new Set();
  }
});

test('Settings move keeps dormant saved ids in their slots', () => {
  state.prefs.set('order.tools', ['ghost', 'marquee', 'gone', 'eyedropper']);
  const root = control();
  row(section(root, 'order.tools'), 'tool:eyedropper').querySelector('[data-direction="up"]').click();
  assert.deepEqual(savedKeys('order.tools'), ['ghost', 'eyedropper', 'marquee', 'gone']);
  state.saves.length = 0;
  state.prefs.delete('order.tools');
});

test('move and toggle keep keyboard focus on the same module row', () => {
  const root = control();
  const up = row(root, 'bench:tray').querySelector('[data-direction="up"]');
  up.focus();
  up.click();
  assert.equal(document.activeElement, row(root, 'bench:tray').querySelector('[data-direction="down"]'),
    'disabled Move Up falls back to Move Down');
  state.saves.length = 0;
  const traySwitch = toggle(root, 'bench:tray');
  traySwitch.focus();
  traySwitch.click();
  assert.equal(document.activeElement, toggle(root, 'bench:tray'));
  toggle(root, 'bench:tray').click();
  assert.equal(document.activeElement, toggle(root, 'bench:tray'));
  state.saves.length = 0;
  state.prefs.delete('order.workbenchTabs');
  state.prefs.delete('modules.hidden');
});

test('project change clears cached MCP rows before the next read lands', async () => {
  const previousAnswer = globalThis.__domMount.answers.read_mcp_servers;
  const pending = [];
  globalThis.__domMount.answers.read_mcp_servers = () => new Promise((resolve) => pending.push(resolve));
  try {
    state.session = { agent: 'claude', art: 'claude', cwd: 'C:\\projectA' };
    const root = control();
    assert.equal(section(root, 'order.rack').querySelectorAll('[data-module-id]').length, 1);
    pending.shift()({ servers: [{ name: 'alpha', scope: 'user', transport: 'stdio', target: 'alpha', args: [], envKeys: [], project: null }], notes: [] });
    await tick();
    assert.ok(root.querySelector('[data-module-id$=":alpha"]'));
    state.session = { agent: 'claude', art: 'claude', cwd: 'C:\\projectB' };
    document.dispatchEvent(new window.CustomEvent('vidar-focus'));
    assert.equal(section(root, 'order.rack').querySelectorAll('[data-module-id]').length, 1,
      'old project rows are unavailable while the next read is pending');
    pending.shift()({ servers: [], notes: [] });
    await tick();
  } finally {
    state.session = null;
    globalThis.__domMount.answers.read_mcp_servers = previousAnswer;
  }
});

test('three lists include current rack rows and Relay stays fixed On', async () => {
  const root = control();
  await tick();
  assert.deepEqual([...section(root, 'order.workbenchTabs').querySelectorAll('[data-module-id]')]
    .map((r) => r.dataset.moduleId),
  ['bench:relay', 'bench:tray', 'bench:doc', 'bench:flow', 'bench:runelib', 'bench:lab', 'bench:changes', 'bench:unreal', 'bench:jira', 'bench:notion', 'bench:slack']);
  assert.deepEqual([...section(root, 'order.tools').querySelectorAll('[data-module-id]')]
    .map((r) => r.dataset.moduleId), ['tool:marquee', 'tool:eyedropper']);
  const rackIds = [...section(root, 'order.rack').querySelectorAll('[data-module-id]')]
    .map((r) => r.dataset.moduleId);
  assert.ok(rackIds.includes('rack:container'));
  assert.ok(rackIds.includes('rack:lmstudio'));
  assert.ok(rackIds.some((id) => id.startsWith('rack:server:user:') && id.endsWith(':alpha')));
  assert.ok(rackIds.some((id) => id.startsWith('rack:server:project:') && id.endsWith(':beta')));
  const relay = toggle(root, 'bench:relay');
  assert.equal(relay.getAttribute('aria-checked'), 'true');
  assert.equal(relay.disabled, true);
  relay.click();
  assert.deepEqual(savedKeys('modules.hidden'), []);
});

test('Hide and Show change the live module state and announce refresh', async () => {
  const root = control();
  const events = [];
  const onChange = () => events.push([...savedKeys('modules.hidden')]);
  document.addEventListener('vidar-modules-change', onChange);
  try {
    toggle(root, 'bench:tray').click();
    assert.deepEqual(savedKeys('modules.hidden'), ['bench:tray']);
    assert.equal(toggle(root, 'bench:tray').getAttribute('aria-checked'), 'false');
    assert.deepEqual(events.at(-1), ['bench:tray']);
    await settle({ status: 'saved', accepted: true });
    toggle(root, 'bench:tray').click();
    assert.deepEqual(savedKeys('modules.hidden'), []);
    assert.equal(toggle(root, 'bench:tray').getAttribute('aria-checked'), 'true');
    assert.deepEqual(events.at(-1), []);
    await settle({ status: 'saved', accepted: true });
  } finally {
    document.removeEventListener('vidar-modules-change', onChange);
  }
});

test('keyboard order controls write the correct surface key', async () => {
  const root = control();
  await tick();
  const changes = [];
  const onChange = () => changes.push('change');
  document.addEventListener('vidar-modules-change', onChange);
  try {
  for (const [listKey, id] of [
    ['order.workbenchTabs', 'bench:tray'],
    ['order.tools', 'tool:eyedropper'],
    ['order.rack', 'rack:lmstudio'],
  ]) {
    const list = section(root, listKey);
    const before = [...list.querySelectorAll('[data-module-id]')].map((r) => r.dataset.moduleId);
    const target = row(list, id);
    const up = target.querySelector('[data-direction="up"]');
    assert.ok(up, `${id} Up button missing`);
    const otherKeys = ['order.workbenchTabs', 'order.tools', 'order.rack'].filter((k) => k !== listKey);
    const otherBefore = otherKeys.map((k) => state.prefs.get(k));
    up.click();
    assert.ok(Array.isArray(savedKeys(listKey)), `${listKey} was not written`);
    const movedList = section(root, listKey);
    const after = [...movedList.querySelectorAll('[data-module-id]')].map((r) => r.dataset.moduleId);
    assert.equal(after.indexOf(id), before.indexOf(id) - 1);
    const localId = id === 'rack:lmstudio' ? 'lmstudio' : id.replace(/^(bench|tool):/, '');
    assert.ok(savedKeys(listKey).includes(localId), `${listKey} omitted ${localId}`);
    assert.deepEqual(otherKeys.map((k) => state.prefs.get(k)), otherBefore,
      `moving ${id} changed another surface order`);
    await settle({ status: 'saved', accepted: true });
    const down = row(movedList, id).querySelector('[data-direction="down"]');
    assert.ok(down, `${id} Down button missing`);
    down.click();
    assert.equal([...section(root, listKey).querySelectorAll('[data-module-id]')].findIndex((r) => r.dataset.moduleId === id),
      before.indexOf(id));
    await settle({ status: 'saved', accepted: true });
  }
  assert.ok(changes.length >= 6, 'each order write should refresh live surfaces');
  } finally {
    document.removeEventListener('vidar-modules-change', onChange);
  }
});

test('Pending persists until patch confirms Saved; refused and session-only saves never say Saved', async () => {
  const root = control();
  const seenErrors = [];
  state.subscriber = (keys, error) => seenErrors.push({ keys, error });
  toggle(root, 'bench:doc').click();
  assert.equal(status(root), 'Pending');
  await tick();
  assert.equal(status(root), 'Pending');
  await settle({ status: 'saved', accepted: true });
  assert.equal(status(root), 'Saved');

  toggle(root, 'bench:doc').click();
  assert.equal(status(root), 'Pending');
  await settle({ status: 'failed', accepted: true });
  assert.equal(status(root), 'Save Failed');
  assert.deepEqual(seenErrors.map((e) => e.keys), [['modules.hidden']]);
  assert.equal(typeof state.subscriber, 'function', 'existing prefs error subscriber was replaced');

  toggle(root, 'bench:flow').click();
  assert.equal(status(root), 'Pending');
  await settle({ status: 'session-only', accepted: true });
  assert.equal(status(root), 'Session Only');
});

// ---- inline rename
const { setModuleNames } = await import('../src/modules/names.ts');
const { REVERT_EVENT } = await import('../src/settings/module-rename.ts');
assert.ok((await import('node:fs')).readFileSync(new URL('../src/settings/modal.ts', import.meta.url), 'utf8')
  .includes(`REVERT_EVENT = "${REVERT_EVENT}"`), 'module-rename.ts listens for the event modal.ts sends');
const resetNames = (disk = {}) => { state.disk = disk; state.writes = []; state.gate = null; setModuleNames(disk); };
const pencil = (root, id) => row(root, id).querySelector('[data-module-rename-open]');
const field = (root, id) => row(root, id).querySelector('input[data-module-rename]');
const label = (root, id) => row(root, id).querySelector('.module-settings__label');
const openField = (root, id) => {
  pencil(root, id).click();
  const input = field(root, id);
  assert.ok(input, `${id} field did not open`);
  assert.equal(document.activeElement, input);
  return input;
};
const type = (input, value) => { input.value = value; input.dispatchEvent(new window.Event('input')); };
const drain = async () => { for (let i = 0; i < 6; i++) await tick(); };

test('every bench and tool row but Relay has the Rename Module pencil; a renamed name shows the built-in tooltip', () => {
  resetNames({ doc: 'Docs' });
  const root = control();
  assert.equal(pencil(root, 'bench:relay'), null);
  assert.equal(pencil(root, 'rack:lmstudio'), null);
  for (const id of ['bench:tray', 'bench:doc', 'tool:marquee', 'tool:eyedropper']) {
    assert.equal(pencil(root, id)?.title, 'Rename Module', id);
  }
  assert.equal(label(root, 'bench:doc').textContent, 'Docs');
  assert.equal(label(root, 'bench:doc').title, 'Built-In Name: Document');
  assert.equal(label(root, 'bench:flow').title, '');
  assert.equal(pencil(root, 'bench:doc').getAttribute('aria-label'), 'Rename Docs');
  assert.equal(toggle(root, 'bench:doc').getAttribute('aria-label'), 'Docs');
  assert.equal(row(root, 'bench:doc').querySelector('[data-direction="up"]').getAttribute('aria-label'), 'Move Docs Up');
  const input = openField(root, 'bench:doc');
  assert.equal(input.placeholder, 'Document');
  assert.equal(input.value, 'Docs');
  assert.equal(input.getAttribute('aria-label'), 'Rename Docs');
  assert.equal(pencil(root, 'bench:doc'), null, 'the pencil gives way to the field');
  input.dispatchEvent(new window.Event(REVERT_EVENT));
  const keywords = getSettingRows().find((r) => r.category === 'modules').keywords();
  assert.match(keywords, /\bDocs\b/);
  assert.match(keywords, /\bDocument\b/);
  resetNames();
});

test('two quick renames end as one map holding both', async () => {
  resetNames();
  const root = control();
  let release;
  state.gate = new Promise((r) => { release = r; });
  let input = openField(root, 'bench:doc');
  type(input, 'Docs');
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(field(root, 'bench:doc'), null, 'Enter closes the field');
  assert.equal(label(root, 'bench:doc').textContent, 'Docs', 'the row shows the name before the write lands');
  assert.equal(status(root), 'Pending');
  input = openField(root, 'bench:flow');
  type(input, '  Graph ');
  input.blur();
  assert.equal(label(root, 'bench:flow').textContent, 'Graph');
  release();
  state.gate = null;
  await drain();
  assert.deepEqual(state.disk, { doc: 'Docs', flow: 'Graph' });
  assert.deepEqual(state.writes.at(-1), { doc: 'Docs', flow: 'Graph' });
  assert.equal(status(root), 'Saved');

  // R1: an emptied field saves the built-in name (the entry goes).
  input = openField(root, 'bench:doc');
  type(input, '');
  input.blur();
  await drain();
  assert.deepEqual(state.disk, { flow: 'Graph' });
  assert.equal(label(root, 'bench:doc').textContent, 'Document');
  resetNames();
});

test('a refused name rolls the row back and says Save Failed', async () => {
  resetNames({ doc: 'Docs' });
  const root = control();
  const input = openField(root, 'bench:doc');
  type(input, 'x'.repeat(200));
  input.blur();
  await drain();
  assert.equal(state.writes.length, 0);
  assert.equal(label(root, 'bench:doc').textContent, 'Docs');
  assert.equal(status(root), 'Save Failed');
  resetNames();
});

test('Escape reverts the field and clears the edit; the modal convention does the same', async () => {
  resetNames();
  const root = control();
  let input = openField(root, 'bench:tray');
  type(input, 'Inbox');
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(field(root, 'bench:tray'), null);
  assert.equal(label(root, 'bench:tray').textContent, 'Tray');
  assert.equal(document.activeElement, pencil(root, 'bench:tray'), 'focus returns to the pencil');
  input = openField(root, 'bench:tray');
  assert.equal(input.value, 'Tray', 'the cleared draft does not come back');
  type(input, 'Inbox');
  input.dispatchEvent(new window.Event(REVERT_EVENT));
  input.blur();
  document.dispatchEvent(new window.CustomEvent('vidar-modules-change'));
  await drain();
  assert.equal(field(root, 'bench:tray'), null, 'a rebuild after the revert opens no field');
  assert.equal(label(root, 'bench:tray').textContent, 'Tray');
  assert.equal(state.writes.length, 0);
});

test('a rebuild mid-edit keeps the open field, its draft and focus, and saves nothing', async () => {
  resetNames();
  const root = control();
  const before = openField(root, 'tool:marquee');
  type(before, 'Rea');
  before.setSelectionRange(1, 2);
  document.dispatchEvent(new window.CustomEvent('vidar-modules-change'));
  const after = field(root, 'tool:marquee');
  assert.ok(after && after !== before, 'the row list was rebuilt');
  assert.equal(after.value, 'Rea');
  assert.equal(document.activeElement, after);
  assert.deepEqual([after.selectionStart, after.selectionEnd], [1, 2]);
  await drain(); // the MCP read lands and rebuilds the rows again
  assert.equal(state.writes.length, 0);
  const latest = field(root, 'tool:marquee');
  assert.equal(latest.value, 'Rea');
  type(latest, 'Reader');
  latest.blur();
  await drain();
  assert.deepEqual(state.disk, { marquee: 'Reader' });
  assert.equal(label(root, 'tool:marquee').textContent, 'Reader');
  resetNames();
});
