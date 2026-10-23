// The built-in `toon` renderer (renderer-registry.ts): any validated glTF, redrawn with banded
// shading and a thin ink outline. Each mesh material becomes a MeshToonMaterial that keeps the
// base colour, its map, alpha mode, normal/emissive/AO maps; skinning and morphs follow the mesh.
// The outline is an inverted hull: a child mesh sharing the geometry (and skeleton and morph
// influences), drawn back faces only and pushed out along the normal, in a dark tint of the base
// colour. Blended (transparent) materials get no hull. Lights and the reveal fade are Standard's.
// Everything created here is registered in `resources` (renderer.ts disposes it); the handle
// removes the hulls and Standard's light rig.
import * as T from "three";
import { softenCelRamp } from "./cel-ramp";
import type { RenderContext, RendererHandle } from "./renderer-registry";
import { applyStandard } from "./style-standard";

/** Light bands, dark to lit, as gradient-map intensity (0..255). */
const BANDS = [118, 186, 255];
const RAMP_WIDTH = 32;
/** Outline width as a fraction of the model's bounding radius (world space). */
const OUTLINE_SCALE = 0.012;
/** Outline colour = base colour (and map) times this. */
const OUTLINE_TINT = 0.22;
const OUTLINE_SUFFIX = "-toon-outline";

export type ToonHandle = RendererHandle & { fade(value: number): void };

function rampTexture(): T.DataTexture {
  const row = new Uint8ClampedArray(RAMP_WIDTH * 4);
  for (let x = 0; x < RAMP_WIDTH; x++) {
    const band = BANDS[Math.min(BANDS.length - 1, Math.floor((x / RAMP_WIDTH) * BANDS.length))];
    row.set([band, band, band, 255], x * 4);
  }
  // Softened edges, sampled linearly: bands stay distinct without a stair-stepped terminator.
  const ramp = new T.DataTexture(softenCelRamp(row), RAMP_WIDTH, 1, T.RGBAFormat);
  ramp.minFilter = T.LinearFilter;
  ramp.magFilter = T.LinearFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  return ramp;
}

/** The source fields a toon material keeps, where the source has them. */
const KEPT = [
  "map", "alphaMap", "alphaTest", "alphaToCoverage", "transparent", "opacity", "side", "vertexColors",
  "depthWrite", "depthTest", "normalMap", "normalMapType", "aoMap", "aoMapIntensity", "emissiveMap",
  "emissiveIntensity", "flatShading", "fog",
] as const;

function toonFrom(source: T.Material, gradientMap: T.Texture): T.MeshToonMaterial {
  const src = source as T.Material & Record<string, unknown>;
  const toon = new T.MeshToonMaterial({ gradientMap });
  const target = toon as unknown as Record<string, unknown>;
  for (const key of KEPT) if (src[key] !== undefined) target[key] = src[key];
  if (src.color instanceof T.Color) toon.color.copy(src.color);
  if (src.emissive instanceof T.Color) toon.emissive.copy(src.emissive);
  if (src.normalScale instanceof T.Vector2) toon.normalScale.copy(src.normalScale);
  toon.name = source.name;
  return toon;
}

function outlineFrom(source: T.MeshToonMaterial, width: number): T.MeshBasicMaterial {
  const outline = new T.MeshBasicMaterial({
    color: source.color.clone().multiplyScalar(OUTLINE_TINT),
    map: source.map,
    side: T.BackSide,
    alphaTest: source.alphaTest,
    vertexColors: source.vertexColors,
  });
  outline.name = `${source.name}${OUTLINE_SUFFIX}`;
  outline.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = { value: width };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float outlineWidth;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed += normalize( normal ) * outlineWidth;");
  };
  // Width is a per-material uniform, so every hull shares one program.
  outline.customProgramCacheKey = () => "vidar-toon-outline-v1";
  return outline;
}

/** A back-face hull for `mesh`, sharing its geometry, skeleton and morph influences. */
function hullFor(mesh: T.Mesh, material: T.Material | T.Material[]): T.Mesh {
  let hull: T.Mesh;
  if (mesh instanceof T.SkinnedMesh) {
    const skinned = new T.SkinnedMesh(mesh.geometry, material);
    skinned.bindMode = mesh.bindMode;
    skinned.bind(mesh.skeleton, mesh.bindMatrix);
    hull = skinned;
  } else {
    hull = new T.Mesh(mesh.geometry, material);
  }
  if (mesh.morphTargetInfluences) hull.morphTargetInfluences = mesh.morphTargetInfluences;
  if (mesh.morphTargetDictionary) hull.morphTargetDictionary = mesh.morphTargetDictionary;
  hull.name = `${mesh.name}${OUTLINE_SUFFIX}`;
  hull.renderOrder = mesh.renderOrder;
  return hull;
}

export async function applyToon(context: RenderContext): Promise<ToonHandle> {
  const { gltf, resources } = context;
  const ramp = rampTexture();
  resources.textures.add(ramp);

  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const radius = new T.Box3().setFromObject(root).getBoundingSphere(new T.Sphere()).radius;
  const worldWidth = Number.isFinite(radius) && radius > 0 ? radius * OUTLINE_SCALE : 0;

  const meshes: T.Mesh[] = [];
  root.traverse((object) => { if (object instanceof T.Mesh) meshes.push(object); });

  const toons = new Map<T.Material, T.MeshToonMaterial>();
  const outlineMaterials: T.MeshBasicMaterial[] = [];
  const hulls: T.Mesh[] = [];
  const scale = new T.Vector3();
  for (const mesh of meshes) {
    const grouped = Array.isArray(mesh.material);
    const next = (grouped ? mesh.material as T.Material[] : [mesh.material as T.Material]).map((source) => {
      let toon = toons.get(source);
      if (!toon) {
        toon = toonFrom(source, ramp);
        toons.set(source, toon);
        resources.materials.add(toon);
      }
      return toon;
    });
    mesh.material = grouped ? next : next[0];

    if (worldWidth === 0 || !mesh.geometry.getAttribute("normal") || next.some((m) => m.transparent)) continue;
    mesh.getWorldScale(scale);
    const width = worldWidth / Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z), 1e-6);
    const outlines = next.map((toon) => outlineFrom(toon, width));
    outlines.forEach((m) => { outlineMaterials.push(m); resources.materials.add(m); });
    const hull = hullFor(mesh, grouped ? outlines : outlines[0]);
    mesh.add(hull);
    hulls.push(hull);
  }

  // Standard's rig and opacity fade, now over the toon materials and the hulls.
  const standard = await applyStandard(context);
  // A hull still fading in must not hide the model behind it.
  outlineMaterials.forEach((m) => { m.depthWrite = false; });

  return {
    fade(value) { standard.fade(value); },
    settle() {
      standard.settle();
      outlineMaterials.forEach((m) => { m.depthWrite = true; });
    },
    dispose() {
      standard.dispose();
      hulls.forEach((hull) => hull.removeFromParent());
    },
  };
}
