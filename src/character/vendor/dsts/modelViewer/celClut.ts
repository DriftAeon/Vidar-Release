import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { textureIndexForImageName } from './glbImages';

// The global engine toon-ramp CLUTs (the game's shared cel ramps). The extractor
// bakes them into every glb (images `common_clut` / `clut001`), so the viewer
// reads a fresh copy from whichever model is loaded - no network fetch, no shared
// singleton. The bytes are identical across the roster, but keeping the load
// per-model means each model is a clean, self-contained render with no dependency
// on a previously-loaded model's textures.
//
//   common_clut (128^2 BC1_UNORM) - `t6`, the DIFFUSE/key ramp: grayscale,
//     shadow 0.5 -> lit 1.0. Sampled by the game's DIRECTIONAL light loop.
//   clut001     (256^2 DXT1)      - `t7`, the SPEC/fill ramp: COOL-tinted,
//     shadow (5,1,16) -> ~0.61 gray. Sampled by the game's point/probe/spot
//     loops - the source of the game's cool shadows (core-fcbd6588e974 asm
//     448-453 vs 583/646/731; both at vec2(NdotL*0.495+0.5, 1-NdotH)).
//
// The viewer rig has only directional lights, so it can't replay the game's
// per-light-TYPE ramp split verbatim; ChrCelEffect maps the rig's KEY light to
// the neutral ramp and FILL lights to the cool ramp (the faithful analog -
// key-neutral / fill-cool -> cool shadows). Both ramps are V-flat (1D on NdotL),
// so the shader samples at a constant V.
//
// They're DATA ramps, not color (BC1_UNORM/linear): NoColorSpace so three
// uploads the texels verbatim, clamp-to-edge (the ramp spans U 0..1), linear
// filter, no mipmaps (a LUT is sampled at its base level; mip bleed would smear
// the terminator at distance).

export interface CelClut {
  /** common_clut - neutral diffuse ramp (key lights). */
  key: THREE.Texture;
  /** clut001 - cool spec ramp (fill lights -> cool shadows). */
  fill: THREE.Texture;
}

/** Apply the data-ramp sampler config (NoColorSpace, clamp, linear, no mips) to
 *  a ramp texture in place. GLTFLoader decodes the embedded PNGs with default
 *  sampler state, so this re-applies the settings a data LUT needs. */
function configureRamp(tex: THREE.Texture): THREE.Texture {
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Build the toon CLUTs from the ramps baked into `gltf` (images `common_clut`
 *  / `clut001`). Resolves to null when the glb carries no baked ramps (a
 *  foreign or pre-bake model) - the caller warns and the chr-cel body renders
 *  without its ramp. The returned textures are per-model and owned by the
 *  viewer: dispose them on model switch (see `clearModel`). */
export async function celClutFromGltf(gltf: GLTF): Promise<CelClut | null> {
  const keyIdx = textureIndexForImageName(gltf, 'common_clut');
  const fillIdx = textureIndexForImageName(gltf, 'clut001');
  if (keyIdx === null || fillIdx === null) return null;
  const [key, fill] = (await Promise.all([
    gltf.parser.getDependency('texture', keyIdx),
    gltf.parser.getDependency('texture', fillIdx),
  ])) as THREE.Texture[];
  return { key: configureRamp(key), fill: configureRamp(fill) };
}
