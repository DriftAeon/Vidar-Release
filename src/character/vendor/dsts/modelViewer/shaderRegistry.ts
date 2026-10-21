// Viewer-side helpers over the canonical `extras.dsts` payload.
//
// The exporter stamps `material.extras.dsts = { shader_hash, ... }` on
// every material (see `data/dsts_extras.schema.json`, a vendored snapshot
// of the format contract - source of truth lives in the dsts-extractor
// repo). Three.js's
// GLTFLoader plumbs glTF material extras into `material.userData`. This
// module exposes typed accessors over that blob. Per-shader dispatch
// lives in the recipe catalog's `shade` stage (`src/recipes/catalog.ts`).

import type * as THREE from 'three';

/**
 * DSTS-specific extras the exporter stamps onto every material it produces.
 * Carries strictly canonical data - game-emitted shader hash and the
 * material's in-game texture-slot bindings. Interpretation (role labels,
 * effect dispatch keys) lives in viewer code, not here.
 *
 * The full schema is documented at `data/dsts_extras.schema.json` (a
 * vendored snapshot in this repo). Keep this interface aligned with that
 * schema when M2+ widens the payload.
 */
export interface DstsExtras {
  shader_hash?: string;
  /**
   * The asset stem this model exported from (`chr391`, `chr750`, `npc014a`,
   * `pc0001a`, etc.). Identical on every material; use it as the canonical
   * own-prefix when comparing against `texture_slots` stems to detect
   * cross-asset borrows.
   */
  model_id?: string;
  shader_filenames?: string[];
  /**
   * In-game shader uniform_name -> texture stem, decoded straight from the
   * .geom material cluster. Lets the viewer detect material categories by
   * the bindings the game itself uses (e.g. matcap meshes have an
   * `InnerGrowAValue` slot bound to `<chr>e01h`) instead of inventing
   * custom mesh-name suffixes.
   */
  texture_slots?: Record<string, string>;
  /**
   * In-game shader uniform_name -> glTF texture index. Parallel map to
   * `texture_slots`: stems are the canonical fact (what the .geom binds);
   * indices are the look-up convenience that points at the embedded
   * `gltf.textures[i]`. Populated by the .glb post-process bundler; older
   * pre-bundler GLBs may omit it (viewers should fall back to stem-matching
   * via image names).
   */
  texture_indices?: Record<string, number>;
  /**
   * In-game shader uniform_name -> constant value tuple (1-4 floats) decoded
   * from the material cluster's uniform slots. Populated by M2; older
   * GLBs may omit it. Read via `getDstsUniform()` so consumers don't have
   * to null-guard nested lookups.
   */
  uniforms?: Record<string, number[]>;
  /**
   * Vertex-stream names present on this material's mesh (e.g. `Position`,
   * `Normal`, `UV`, `UV2`, `Colour`). Used by viewer effects to detect
   * material categories (the eye-overlay materials are the ones that sample
   * b01 via UV2). Populated by M2.
   */
  vertex_streams?: string[];
  /**
   * The .geom mesh record's `material_name`. Debug aid only - viewer
   * effects must not key off substrings of this name (use
   * `texture_slots` + `shader_hash` instead). Populated by M2.
   */
  material_name?: string;
}

/** Legacy `overlay_mode` classification the extractor still bakes. The viewer NO
 *  LONGER branches on it: RE proved the two "families" run the byte-identical body fp
 *  (meramon "composite" == birdramon "distort", capture eid 573 == 470), so every
 *  flaming-skin body takes the single `CHR_HAS_FLOW_OVERLAY` path. Kept only to type
 *  the baked field; its presence is what grants the `flowOverlay` feature in resolve.ts. */
export type FlameOverlayMode = 'composite' | 'distort';

/**
 * Recovered per-draw render/shading state the exporter bakes onto a material as
 * the fenced sibling `extras.dsts_render` (a peer of `dsts`, never a key inside
 * it). Present only on the handful of meshes whose blend / cull / flame family
 * can't be reconstructed from `extras.dsts` alone - absence means engine/glTF
 * default. Canonical-recovered, not invented: blend/cull live in the static
 * `.shad` rasterizer block, `overlay_mode` in the fp.asm; the exporter recovers
 * each by hand (see the extractor's `data/render_state.json` +
 * `notes/render-state-table.md`). `provenance` documents how each row was
 * established.
 */
export interface DstsRenderState {
  /** Override authored alpha-mode to a smooth per-pixel BLEND. Only ever
   *  `'BLEND'`; OPAQUE/MASK are the authored default and never baked here. */
  alpha_mode?: 'BLEND';
  double_sided?: boolean;
  /** Per-draw texture addressing for the material's diffuse sampler. The eff-card
   *  vertex shader adds `OffsetSet1` to UV0 with no frac and no clamp, so what
   *  happens outside [0,1] is decided purely here - state the `.asm` cannot carry
   *  and glTF's empty sampler defaults to REPEAT on both axes. The eff atlases want
   *  Wrap U + ClampEdge V; without the clamp the opaque bottom row wraps onto the
   *  transparent top and fringes the card edge. */
  sampler?: { wrap_u?: 'repeat' | 'clamp'; wrap_v?: 'repeat' | 'clamp' };
  /** Draw the material ADDITIVE (`SrcAlpha,One`) instead of its authored blend.
   *  Recovered from the per-draw OM blend state (a peer of cull/alpha_mode); the
   *  viewer sets `AdditiveBlending` + `transparent` + no depth-write. Only ever
   *  `'add'`; absence means the authored/normal blend. Baked on emissive cores the
   *  engine draws additive - e.g. Apollomon's fb_03/fb_04 head-fireball inner
   *  cores. Distinct from `alpha_mode:'BLEND'` (normal SrcAlpha/InvSrcAlpha). */
  blend_op?: 'add';
  /** Flaming-skin body fp family (`composite` | `distort`). Present ONLY on the
   *  flame-body materials; absent everywhere else. Selects the ChrCel flow branch
   *  downstream and grants the `flowOverlay` load-time feature (see resolve.ts). */
  overlay_mode?: FlameOverlayMode;
  /** Draw the material with depth-WRITE off (fire overlays never occlude). Baked
   *  on all four Apollomon fireball layers; the additive cores already imply it,
   *  but it also covers the OPAQUE-but-non-occluding fb_01 no blend field can
   *  express. Recovered per-draw (rdc-fire-depth.py); absence = engine default. */
  depth_write?: boolean;
  /** Camera-facing billboard: the material's vertex program maps the object quad
   *  onto a camera basis anchored at `bone` (an index into the skin's `joints`).
   *  The viewer feeds `skeleton.bones[bone].matrixWorld` as a per-frame uniform
   *  (can't reconstruct it in-shader on the meshopt glb). Baked on fb_02
   *  (0xcef1bb79). See BillboardEffect + notes/fb01-fireball-recipe.md. */
  billboard?: { bone: number };
  provenance?: string;
}

/**
 * Read the DSTS extras blob the exporter stamped onto a material. Returns
 * `null` when the material wasn't produced by our pipeline (e.g. a viewer-
 * synthesized matcap or any third-party glTF loaded for testing).
 */
export function getDstsExtras(mat: THREE.Material): DstsExtras | null {
  const ud = mat.userData as { dsts?: DstsExtras } | undefined;
  return ud?.dsts ?? null;
}

/**
 * Read the recovered render-state the exporter baked onto a material. Returns
 * `null` for materials with no baked state (the default) and for models
 * exported before the render-state bake existed. Survives the `userData`
 * shallow-spreads in `chrCel`/`bodyOverlay` (a top-level key like `dsts`).
 */
export function getDstsRenderState(mat: THREE.Material): DstsRenderState | null {
  const ud = mat.userData as { dsts_render?: DstsRenderState } | undefined;
  return ud?.dsts_render ?? null;
}

/** The baked camera-facing-billboard descriptor (attach-bone index into the
 *  skin's `joints`), or `null` when the material is not a billboard. Read off
 *  the recovered render-state; survives chrCel's `userData` spread. */
export function getDstsBillboard(mat: THREE.Material): { bone: number } | null {
  const b = getDstsRenderState(mat)?.billboard;
  return b && Number.isInteger(b.bone) ? b : null;
}

/** True iff this material is bound through the in-game matcap slot
 *  (`InnerGrowAValue` -> `<chr>e01h`). The iris-hemisphere meshes are
 *  the only DSTS materials with this slot. */
export function isMatcapMaterial(mat: THREE.Material): boolean {
  return getDstsExtras(mat)?.texture_slots?.InnerGrowAValue != null;
}

// The upper-eye shading shell (`eye_s`): one shared program hash across the
// whole roster (swept eye_s-exclusive over all 575 models, both delivery trees).
// Under chr-cel it rides the ChrCel catch-all with a baked BLEND alpha (a soft
// translucent tint over the eyes); outside chr-cel it has no valid interpretation
// and renders as an opaque blue blob, so the manager hides it there - like the
// outline + eye-shine layers.
const EYE_SHADOW_SHADER_HASH = '0xc40b771f';

/** True iff this material is the `eye_s` upper-eye shading shell (matched by its
 *  canonical, roster-exclusive `shader_hash`). */
export function isEyeShadowMaterial(mat: THREE.Material): boolean {
  return getDstsExtras(mat)?.shader_hash === EYE_SHADOW_SHADER_HASH;
}

// Noise-distortion (fire flame-boil) signature: the flow-noise atlas stem
// (chr_f01n / chr_f02n) bound on the Bumpiness slot (-> three's normalMap).
// Meshes carrying this noise + the ScrollSpeedSet2U scroll uniform are the fire
// churn family the game renders through the chr toon ubershader.
const UV_DISTORT_NOISE_STEM = /^(chr_f\d+|chr\d+(?:_f|f)\d+|chr\d+_fire\d*)n$/;

/** True iff this material carries the noise-distortion (fire flame-boil)
 *  signature: a `chr_fNNn` flow-noise atlas on the Bumpiness slot (three's
 *  `normalMap`) AND the `ScrollSpeedSet2U` scroll uniform. ChrCel warps the
 *  diffuse UV by this scrolling noise (`CHR_HAS_UV_DISTORT`), taking the noise
 *  off the body-normal path. Read off the vanilla `MeshStandardMaterial` BEFORE
 *  dispatch, so it also gates the Flames toggle / shadow exclusion / effects
 *  availability - the single pre-dispatch check the flame-boil churn meshes (now
 *  on ChrCel) are recognized by. */
export function isUvDistortMaterial(mat: THREE.Material): boolean {
  // Post-dispatch: the compiled ChrCel ShaderMaterial has folded the noise off
  // `normalMap` into the `uFireNoise` uniform, so the vanilla signature is gone -
  // the `CHR_HAS_UV_DISTORT` define is the reliable marker. This keeps the check
  // order-independent (shadow flags + availability run after dispatch).
  const def = (mat as THREE.ShaderMaterial).defines;
  if (def && 'CHR_HAS_UV_DISTORT' in def) return true;
  // Pre-dispatch: the vanilla MeshStandardMaterial still carries the flow-noise
  // on the Bumpiness slot + the scroll uniform.
  const normalMap = (mat as { normalMap?: THREE.Texture | null }).normalMap ?? null;
  if (!normalMap || !UV_DISTORT_NOISE_STEM.test(normalMap.name)) return false;
  return getDstsUniform(mat, 'ScrollSpeedSet2U') != null;
}

/** Resolve the texture stem bound to `slot` on this material, or null if
 *  the slot is unbound (or the material has no extras at all). */
export function getDstsTextureSlot(mat: THREE.Material, slot: string): string | null {
  return getDstsExtras(mat)?.texture_slots?.[slot] ?? null;
}

/** Resolve the glTF texture index bound to `slot` on this material. Returns
 *  null if the slot is unbound, or if the GLB pre-dates the post-process
 *  bundler that populates `texture_indices`. Look the index up against
 *  `gltf.parser.getDependency('texture', idx)` (load-time) or against the
 *  parser's cached `gltf.textures` (post-load). */
export function getDstsTextureIndex(mat: THREE.Material, slot: string): number | null {
  return getDstsExtras(mat)?.texture_indices?.[slot] ?? null;
}

/** Resolve the value tuple for one of this material's shader uniforms,
 *  or null when the uniform isn't bound. Tuple lengths are 1-4 floats per
 *  the canonical-extras schema; callers reinterpret components as needed
 *  (some uniforms pack u32s into the float slot). */
export function getDstsUniform(mat: THREE.Material, name: string): number[] | null {
  return getDstsExtras(mat)?.uniforms?.[name] ?? null;
}

/** True iff this material's mesh streams the named vertex attribute
 *  (e.g. `UV2`, `Colour`). Used by composer effects to detect category
 *  signatures without resorting to mesh-name heuristics. */
export function hasDstsVertexStream(mat: THREE.Material, stream: string): boolean {
  return getDstsExtras(mat)?.vertex_streams?.includes(stream) === true;
}

/** True iff ANY of `mat`'s slot materials are matcap-bound. */
export function meshHasMatcapMaterial(
  mat: THREE.Material | THREE.Material[] | null | undefined,
): boolean {
  if (!mat) return false;
  const mats = Array.isArray(mat) ? mat : [mat];
  return mats.some(isMatcapMaterial);
}
