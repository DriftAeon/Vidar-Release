import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mount.mjs';

setupDom({
  stubs: {
    'tools/marquee': 'export const marqueeTool = () => ({});',
    'tools/eyedropper': 'export const eyedropperTool = () => ({});',
    'panels/inspect': 'export const exitInspect = () => {}; export const onInspectEnter = () => {};',
    prefs: 'export const getPref = () => []; export const setPref = () => true;',
  },
});

const { BUILTIN_TOOL_MODULES, createToolRegistry } = await import('../src/tools/registry.ts');

test('built-in toolbar registry keeps Marquee then Eyedropper optional', () => {
  const descriptors = createToolRegistry();
  assert.deepEqual(Array.from(descriptors, ({ id }) => id), ['marquee', 'eyedropper']);
  assert.deepEqual(Array.from(descriptors, ({ level }) => level), ['optional', 'optional']);
  assert.deepEqual(Array.from(descriptors, ({ label }) => label), ['Marquee Read Text', 'Eyedropper']);
});

const { initToolbench } = await import('../src/panels/toolbench.ts');

/** Descriptor whose load and factory calls are counted. */
function counted(id) {
  const calls = { load: 0, create: 0, created: [] };
  const descriptor = {
    id, label: id, level: 'optional',
    load: async () => {
      calls.load++;
      return () => {
        calls.create++;
        const tool = { id, label: id, glyph: id[0], canvas: 'none', mount() {}, arm() {}, disarm() {}, dispose() {} };
        calls.created.push(tool);
        return tool;
      };
    },
  };
  return { descriptor, calls };
}

test('registry filters by enabled ID before any factory loads', async () => {
  const a = counted('a');
  const b = counted('b');
  const filtered = createToolRegistry((id) => id === 'a', [a.descriptor, b.descriptor]);
  assert.deepEqual(filtered.map(({ id }) => id), ['a']);
  await initToolbench(document.createElement('div'), document.createElement('div'), filtered);
  assert.deepEqual([b.calls.load, b.calls.create], [0, 0], 'filtered-out tool never loads or creates');
  assert.deepEqual([a.calls.load, a.calls.create], [1, 1]);
  assert.deepEqual(createToolRegistry(() => false, [a.descriptor, b.descriptor]), []);
  assert.deepEqual(createToolRegistry((id) => id === 'marquee').map(({ id }) => id), ['marquee']);
});

test('registry rejects duplicate IDs before any factory runs', async () => {
  const a = counted('a');
  assert.throws(() => createToolRegistry(() => true, [a.descriptor, { ...a.descriptor }]), /duplicate|twice/i);
  assert.throws(() => createToolRegistry(() => false, [a.descriptor, { ...a.descriptor }]), /duplicate|twice/i);
  const [first] = BUILTIN_TOOL_MODULES;
  assert.throws(() => createToolRegistry(() => true, [first, { ...first }]), /duplicate|twice/i);
  assert.deepEqual([a.calls.load, a.calls.create], [0, 0]);
});

test('each mount calls each factory once and receives fresh tool instances', async () => {
  const a = counted('a');
  const b = counted('b');
  const registry = createToolRegistry(() => true, [a.descriptor, b.descriptor]);
  assert.deepEqual([a.calls.load, a.calls.create, b.calls.load, b.calls.create], [0, 0, 0, 0], 'registry alone creates nothing');
  await initToolbench(document.createElement('div'), document.createElement('div'), registry);
  await initToolbench(document.createElement('div'), document.createElement('div'), registry);
  assert.deepEqual([a.calls.load, a.calls.create], [2, 2]);
  assert.deepEqual([b.calls.load, b.calls.create], [2, 2]);
  assert.equal(a.calls.created.length, 2);
  assert.notStrictEqual(a.calls.created[0], a.calls.created[1]);
  assert.notStrictEqual(b.calls.created[0], b.calls.created[1]);
});

test('registry descriptors carry no dispose; tools keep their own', () => {
  const a = counted('a');
  for (const descriptor of [...createToolRegistry(), a.descriptor]) {
    assert.equal('dispose' in descriptor, false);
  }
});
