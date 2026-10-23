// style-toon.ts: the built-in `toon` renderer sits after `standard`, `auto` never picks it, a
// pack naming it gets it, and everything its `apply` creates is released by renderer.ts's
// dispose path (handle.dispose, then the resource sets) on a small in-memory scene.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as T from 'three';

const SRC = new URL('../src/character/', import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@character-addons') {
      return { url: `data:text/javascript,${encodeURIComponent('export const addons = {};')}`, shortCircuit: true };
    }
    // src imports drop the extension (Vite resolves them); the lazy renderer modules need it here.
    if (specifier.startsWith('./') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.startsWith(SRC)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { RENDERER_CONTRACT, buildRegistry, chooseMaterialStyle, renderers } = await import('../src/character/renderer-registry.ts');
const { collectResources } = await import('../src/character/materials.ts');

const LIGHTING = { ambient: 0.65, key: 0.4, fill: 0.06 };
const emptyResources = () => ({ materials: new Set(), textures: new Set(), geometries: new Set(), skeletons: new Set() });

test('the registry lists standard then toon, labelled Toon', () => {
  assert.deepEqual(renderers().map((r) => r.id), ['standard', 'toon']);
  assert.equal(renderers()[1].label, 'Toon');
});

test('auto with no addon picks standard; a pack naming toon resolves to it', async () => {
  const pick = async (pref, list = renderers()) => (await chooseMaterialStyle(pref, {}, emptyResources(), list)).style.id;
  assert.equal(await pick('auto'), 'standard');
  assert.equal(await pick('toon'), 'toon');
  assert.equal((await chooseMaterialStyle('toon', {}, emptyResources())).note, null);
  const addon = {
    contract: RENDERER_CONTRACT, id: 'extra', label: 'Extra', marker: 'M:extra',
    async accepts() { return true; }, async apply() { return { settle() {}, dispose() {} }; }, materialize() {},
  };
  const list = buildRegistry({ './addons/extra/index.ts': { default: addon } });
  assert.deepEqual(list.map((r) => r.id), ['standard', 'toon', 'extra']);
  assert.equal(await pick('auto', list), 'extra');
});

function model() {
  const root = new T.Group();
  const texture = new T.Texture();
  const base = new T.MeshStandardMaterial({ color: 0x3366cc, map: texture });
  const blended = new T.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
  const box = new T.Mesh(new T.BoxGeometry(1, 1, 1), base);
  const glass = new T.Mesh(new T.BoxGeometry(0.5, 0.5, 0.5), blended);
  const bone = new T.Bone();
  const skinGeometry = new T.BoxGeometry(0.3, 0.3, 0.3);
  const count = skinGeometry.getAttribute('position').count;
  skinGeometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
  skinGeometry.setAttribute('skinWeight', new T.Float32BufferAttribute(new Array(count * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  const skinned = new T.SkinnedMesh(skinGeometry, base);
  skinned.add(bone);
  skinned.bind(new T.Skeleton([bone]));
  root.add(box, glass, skinned);
  return { root, base, blended, texture, box, glass, skinned };
}

test('apply keeps colour, map and alpha mode, adds hulls, and disposal releases what it created', async () => {
  const toon = renderers().find((r) => r.id === 'toon');
  const m = model();
  const scene = new T.Scene();
  scene.add(m.root);
  const resources = emptyResources();
  collectResources(m.root, resources);
  const before = { materials: new Set(resources.materials), textures: new Set(resources.textures), geometries: new Set(resources.geometries) };
  const lightsBefore = scene.children.length;

  const handle = await toon.apply({ gltf: { scene: m.root }, resources, lighting: LIGHTING, scene });
  assert.ok(m.box.material instanceof T.MeshToonMaterial);
  assert.equal(m.box.material, m.skinned.material, 'a shared source material maps to one toon material');
  assert.equal(m.box.material.map, m.texture);
  assert.ok(m.box.material.color.equals(m.base.color));
  assert.ok(m.box.material.gradientMap instanceof T.DataTexture);
  assert.equal(m.glass.material.transparent, true);
  assert.ok(scene.children.length > lightsBefore, 'light rig added');

  const hulls = [];
  m.root.traverse((o) => { if (o.name.endsWith('-toon-outline')) hulls.push(o); });
  assert.equal(hulls.length, 2, 'box and skinned mesh get a hull; the blended mesh does not');
  const skinHull = hulls.find((h) => h.parent === m.skinned);
  assert.ok(skinHull instanceof T.SkinnedMesh);
  assert.equal(skinHull.skeleton, m.skinned.skeleton);
  assert.equal(skinHull.geometry, m.skinned.geometry);
  assert.equal(skinHull.material.side, T.BackSide);

  // Reveal: fades from 0, settle restores opacity and the hull's depth write.
  toon.materialize(handle, 0);
  assert.equal(m.box.material.opacity, 0);
  toon.materialize(handle, 0.5);
  assert.equal(m.glass.material.opacity, 0.25);
  handle.settle();
  assert.equal(m.box.material.opacity, 1);
  assert.equal(m.box.material.transparent, false);
  assert.equal(skinHull.material.depthWrite, true);

  const created = {
    materials: [...resources.materials].filter((x) => !before.materials.has(x)),
    textures: [...resources.textures].filter((x) => !before.textures.has(x)),
    geometries: [...resources.geometries].filter((x) => !before.geometries.has(x)),
  };
  assert.equal(created.materials.length, 4, 'two toon materials plus two hull materials');
  assert.equal(created.textures.length, 1, 'the gradient ramp');
  assert.equal(created.geometries.length, 0, 'hulls share geometry');

  const released = new Set();
  for (const x of [...created.materials, ...created.textures, ...before.materials, ...before.geometries]) {
    x.addEventListener('dispose', () => released.add(x));
  }
  // renderer.ts dispose(): handle first, then every resource collected from the root.
  handle.dispose();
  m.root.removeFromParent();
  collectResources(m.root, resources);
  resources.skeletons.forEach((s) => s.dispose());
  resources.geometries.forEach((g) => g.dispose());
  resources.materials.forEach((x) => x.dispose());
  resources.textures.forEach((x) => x.dispose());

  assert.equal(scene.children.length, 0, 'light rig removed');
  const left = [];
  m.root.traverse((o) => { if (o.name.endsWith('-toon-outline')) left.push(o); });
  assert.equal(left.length, 0, 'hulls removed');
  for (const x of [...created.materials, ...created.textures, ...before.materials, ...before.geometries]) {
    assert.ok(released.has(x), `${x.type} ${x.name} released`);
  }
  assert.equal(resources.geometries.size, before.geometries.size, 'no geometry beyond the model\'s own');
});
