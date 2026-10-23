// renderer-registry.ts: standard is built in and first, addons join by contract version, `auto`
// takes the first accepting addon, a named renderer that is not installed falls back to
// Standard with the note, and clip roles resolve through the model's clip map. The local `cel`
// addon (gitignored) is checked only when it is on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@character-addons') {
      return { url: `data:text/javascript,${encodeURIComponent('export const addons = {};')}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const {
  RENDERER_CONTRACT, NEUTRAL_CLIPS, buildRegistry, chooseMaterialStyle, clipForRole, clipLabelFor, clipMapFor, renderers,
} = await import('../src/character/renderer-registry.ts');

const addon = (id, over = {}) => ({
  contract: RENDERER_CONTRACT, id, label: id.toUpperCase(), marker: `M:${id}`,
  async accepts() { return true; }, async apply() { return { settle() {}, dispose() {} }; }, materialize() {},
  ...over,
});
const quiet = (fn) => {
  const warn = console.warn;
  const seen = [];
  console.warn = (msg) => seen.push(msg);
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
};

test('with no addons the registry is the built-ins alone', () => {
  assert.deepEqual(renderers().map((r) => r.id), ['standard', 'toon']);
});

test('addons join after standard; a contract mismatch, bad id or repeat is skipped with a warning', () => {
  const { value, seen } = quiet(() => buildRegistry({
    './addons/a/index.ts': { default: addon('a') },
    './addons/b/index.ts': { default: addon('b', { contract: RENDERER_CONTRACT + 1 }) },
    './addons/c/index.ts': { default: addon('Bad Id') },
    './addons/d/index.ts': { default: addon('a') },
    './addons/e/index.ts': { default: addon('e', { marker: 'M:other' }) },
    './addons/f/index.ts': {},
  }));
  assert.deepEqual(value.map((r) => r.id), ['standard', 'toon', 'a']);
  assert.equal(seen.length, 5);
  assert.match(seen[0], /contract/);
});

test('auto takes the first accepting addon, else standard; named ids fall back with notes', async () => {
  const list = buildRegistry({
    './addons/no/index.ts': { default: addon('no', { async accepts() { return false; }, rejectNote: 'Nope' }) },
    './addons/yes/index.ts': { default: addon('yes') },
  });
  const pick = async (pref) => { const r = await chooseMaterialStyle(pref, {}, {}, list); return [r.style.id, r.note]; };
  assert.deepEqual(await pick('auto'), ['yes', null]);
  assert.deepEqual(await pick('standard'), ['standard', null]);
  assert.deepEqual(await pick('yes'), ['yes', null]);
  assert.deepEqual(await pick('no'), ['standard', 'Nope']);
  assert.deepEqual(await pick('missing'), ['standard', 'Renderer Not Installed, Showing Standard']);
  const only = buildRegistry({});
  assert.deepEqual((await chooseMaterialStyle('auto', {}, {}, only)).style.id, 'standard');
});

test('neutral clip roles: a clip named after the role, idle falls back to the first clip', () => {
  const clips = [{ name: 'Wave' }, { name: 'hero_Run' }, { name: 'Idle' }];
  const map = clipMapFor(renderers()[0], clips.map((c) => c.name));
  assert.equal(map, NEUTRAL_CLIPS);
  assert.equal(clipForRole(map, 'idle', clips)?.name, 'Idle');
  assert.equal(clipForRole(map, 'run', clips)?.name, 'hero_Run');
  assert.equal(clipForRole(map, 'yes', clips), null);
  assert.equal(clipForRole(map, 'idle', [{ name: 'Wave' }])?.name, 'Wave');
  assert.equal(clipLabelFor(map, 'hero_Run'), 'hero_Run');
});

test('auto: an addon whose accepts throws counts as not accepting', async () => {
  const list = buildRegistry({
    './addons/boom/index.ts': { default: addon('boom', { async accepts() { throw new Error('import failed'); } }) },
  });
  const { value } = await (async () => {
    const warn = console.warn; const seen = [];
    console.warn = (...m) => seen.push(m);
    try { return { value: await chooseMaterialStyle('auto', {}, {}, list), seen }; } finally { console.warn = warn; }
  })();
  assert.equal(value.style.id, 'standard');
  assert.equal(value.note, null);
});

test('an addon with a malformed clips map is skipped', () => {
  const { value } = quiet(() => buildRegistry({
    './addons/a/index.ts': { default: addon('a', { clips: { roles: {} } }) },
    './addons/b/index.ts': { default: addon('b', { clips: { roles: {}, label: () => null } }) },
  }));
  assert.deepEqual(value.map((r) => r.id), ['standard', 'toon', 'b']);
});

const MARKER_PREFIX = 'VIDAR_ADDON_' + 'MARKER';
const ADDONS_DIR = new URL('../src/character/addons/', import.meta.url);
const onDisk = existsSync(ADDONS_DIR) ? readdirSync(ADDONS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(new URL(`${e.name}/index.ts`, ADDONS_DIR))) : [];
for (const entry of onDisk) {
  test(`addon ${entry.name}: marker is the audit prefix plus its id`, async () => {
    const mod = (await import(new URL(`${entry.name}/index.ts`, ADDONS_DIR).href)).default;
    assert.ok(mod.marker.startsWith(`${MARKER_PREFIX}:`), mod.marker);
    assert.ok(mod.marker.endsWith(`:${mod.id}`), mod.marker);
  });
}

const CEL = new URL('../src/character/addons/cel/index.ts', import.meta.url);
test('cel addon: registers, and its clip map keeps the pack clip behaviour', { skip: !existsSync(CEL) && 'cel addon not on disk' }, async () => {
  const cel = (await import(CEL.href)).default;
  const list = buildRegistry({ './addons/cel/index.ts': { default: cel } });
  assert.deepEqual(list.map((r) => r.id), ['standard', 'toon', 'cel']);
  const clips = ['chr1_bn01', 'chr1_bn02', 'chr1_f002', 'chr1_fq01', 'chr1_zz09'].map((name) => ({ name }));
  // Picked even when the model falls back to standard, so a pack's clips keep their roles.
  const map = clipMapFor(list[0], clips.map((c) => c.name), list);
  assert.equal(map, cel.clips);
  assert.equal(clipForRole(map, 'idle', clips)?.name, 'chr1_bn01');
  assert.equal(clipForRole(map, 'tired', clips)?.name, 'chr1_bn02');
  assert.equal(clipForRole(map, 'rest', clips)?.name, 'chr1_f002');
  assert.equal(clipForRole(map, 'yes', clips)?.name, 'chr1_fq01');
  assert.equal(clipForRole(map, 'run', clips), null);
  assert.equal(clipLabelFor(map, 'chr1_bn02'), 'Idle (Low HP)');
  assert.equal(clipLabelFor(map, 'chr1_zz09'), 'Clip ZZ09');
});
