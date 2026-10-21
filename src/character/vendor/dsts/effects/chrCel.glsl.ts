// GLSL for the ported chr cel/eye lighting model (ChrCelEffect): a static #ifdef
// superset (buildChrCelSuperset) specialized per-material by chrCelMatDefines. The
// fragment is a faithful-but-scoped transcription of the game body shader; magic
// constants are imported from chrCel.math.ts (single source of truth) and templated
// in, so the GLSL and the unit-tested TS can never drift.
//
// The emitted GLSL also ships as a public product (the cel-shader export kit), so
// its inline comments are lightweight "what it does" markers that point at the kit
// README by named anchor. The reverse-engineering provenance (asm line numbers, cb0
// indices, capture eids, engineering rationale, v1 scope) lives in
// notes/chr-cel-glsl-annotations.md - the for-us companion, with deeper dives in
// notes/chr-cel-{color-pipeline,spec-reflection,emissive-re,body-overlay-re}.md and
// the parity roadmap.
//
// Vehicle: THREE.ShaderMaterial with three-owned vertex chunks (skinning stays
// free) and a fully-owned fragment. The BODY material runs lights:true so three
// populates its shadow uniforms; the EYE material stays lights:false.

import {
  ACOS_C0,
  ACOS_C1,
  ACOS_C2,
  ACOS_C3,
  BAYER17,
  INV_PI,
  SH_L0,
  SH_L1,
  SH_L2_CROSS,
  SH_L2_M0,
  SH_L2_M2,
  MAX_RIG_LIGHTS,
  TOON_U_BIAS,
  TOON_U_SCALE,
  TWO_OVER_PI,
} from './chrCel.math';

export interface ChrCelDefines {
  /** Claimed mesh is a SkinnedMesh -> activate the three skinning chunks. */
  skinning: boolean;
  /** A baseColor map is bound. */
  hasMap: boolean;
  /** chr_env reflection term active (body materials carrying the
   *  `ReflectionStrength` slot - Dorugamon's gem bucket). Compiles the cube
   *  sample + a01m.g mask into the body path; off everywhere else so plain
   *  body meshes don't pay for it. See the reflection block in the fragment. */
  hasEnvReflect: boolean;
  /** UV set the bound baseColor map is indexed by (three's `tex.channel`):
   *  0 = `uv` (TEXCOORD_0, body skin), 1 = `uv1`, 2 = `uv2`. Eye-overlay face
   *  meshes carry the baked composite on channel 2 (or 1 on 2-UV mask meshes);
   *  the plain body diffuse is channel 0. MUST be part of the program cache key
   *  - body and face meshes share every other define, so without it they'd
   *  collide on one compiled program and the face would sample the body UV. */
  mapChannel: 0 | 1 | 2;
  /** An `a01n` normal map (the `Bumpiness` slot, three's `normalMap`) is bound
   *  AND the mesh carries the game's `TANGENT` attribute. Compiles the
   *  world-space TBN normal-map perturbation into the body path; off everywhere
   *  else (eyes/outline carry no tangent, eye-overlay meshes no normal map).
   *  The normal map shares the diffuse's TEXCOORD_0, so it samples `vChrUv`
   *  (identity offset/repeat on the plain body diffuse). See the body fragment. */
  hasNormalMap: boolean;
  /** An `a01s` spec atlas (the `BackBufferSampler` slot) is bound AND resolved.
   *  Compiles the inner-glow rim's `a01s.w` mask (asm 113 `t6.xwyz` -> r0.y,
   *  multiplied into the rim at asm 777) into the body path so the rim only
   *  shows where the game intends. Off elsewhere (eyes/outline). The atlas is
   *  orphaned from the standard glTF channels, so it's resolved at load and
   *  shared per-model - see chrSpecMask in viewer.ts. */
  hasSpecMask: boolean;
  /** An `em` emissive atlas (the `LightPixelProj` slot -> three `emissiveMap`) is
   *  bound AND emits (EmissiveSampler strength > 0). Compiles the post-lighting,
   *  pre-fog emissive add `color += em.rgb x EmissiveIntensity x EmissiveSampler`
   *  - the faithful term recovered from the alphamon gem capture (see
   *  notes/chr-cel-emissive-re.md; cb0[1018] = [tint.rgb, strength]). The em atlas
   *  the body diffuse UV (channel 0); eye-emissive meshes carry it on a higher
   *  UV set (see `emMapChannel`). */
  hasEmissive: boolean;
  /** A body-decal overlay (`OverlayNormalSampler` color atlas, e.g. Impmon's
   *  belly smiley `a02`) is resolved AND the mesh carries TEXCOORD_1. Composites
   *  `albedo = mix(a01, overlay, overlay.a * OverlayStrength)` at the decal's UV1
   *  before the DiffuseAlpha tint - the body shader's overlay block (RE'd from
   *  chr081 body `_fp.shad` 49-64; notes/chr-cel-body-overlay-re.md). Off
   *  everywhere else (eyes/outline, and bodies with no decal). The atlas is
   *  orphaned from the glTF channels, so it's resolved at load and stashed on
   *  the material - see overlayLayers.ts / getOverlayLayers. */
  hasBodyOverlay: boolean;
  /** Composite the overlay ADDITIVELY instead of lerping it. Both are the same
   *  weighted operation on `src.a * strength`; only the combine differs, and the
   *  engine picks per layer (derived per program in
   *  data/overlay_program_ids.json, read off the disassembly). Additive is what
   *  tigervespamon's dark markings atlas wants - a lerp there would paste an
   *  opaque texture over the body, which is exactly why the retired
   *  `isOpaqueAtlas` heuristic had been suppressing it. Ignored unless
   *  `hasBodyOverlay`. Part of the cache key. */
  overlayAdd: boolean;
  /** A SECOND overlay layer (the engine's layer 3, `$OverlayColorSampler2` in
   *  RDEF / `OverlayColorSampler3` in the material slots). It is composited AFTER
   *  layer 2, and it samples the DIFFUSE UV (engine v4), not a third UV set - so
   *  "layer index == UV index" does not extend here, which is why it needs its own
   *  varying rather than a channel number. Part of the cache key. */
  hasOverlayL3: boolean;
  /** Composite layer 3 additively rather than lerping it. Same per-program
   *  derivation as `overlayAdd`. Ignored unless `hasOverlayL3`. */
  overlayL3Add: boolean;
  /** The `$PhantomGrowTexture` layer - a WORLD-SPACE triplanar projection added
   *  over the lit colour, scrolling by the material's `ScrollSpeedSet2U`.
   *  RenderDoc-confirmed on chronomon-hm/dm (notes/chr-cel-overlay-model.md 6d):
   *  this is the "rolling white" that fades in after a model loads, and it is
   *  what made the two-layer materials look unfinished. Part of the cache key. */
  hasPhantomGrow: boolean;
  /** UV set the emissive (`em`) atlas is indexed by (three's `emissiveMap.channel`):
   *  0 = `uv`, 1 = `uv1`, 2 = `uv2`. Body emissive shares the diffuse UV (0);
   *  eye-emissive samples a higher set + an expression-row offset (RE'd from the
   *  ancientwisemon p01 capture - em = TEXCOORD5 <- UV2 + cb0 offset, distinct
   *  from the diffuse's TEXCOORD4 <- UV0). Routed into `vEmUv` independently of the
   *  diffuse `vChrUv`. Part of the cache key. */
  emMapChannel: 0 | 1 | 2;
  /** Flaming-skin body (any flaming-skin digimon - meramon, birdramon, megidramon,
   *  centarumon, ...). Resolved at load when the mesh carries TEXCOORD_1 and the material
   *  binds the `OverlayDistortionStrength` `chr_fNNn` flow-noise (see flowOverlay.ts /
   *  getFlowOverlay). ONE branch for every flaming-skin body: warp the flesh AND emissive
   *  sampling UV by the scrolling flow-noise so the body boils (`uv1 += (noise(uv1 +
   *  frac(t*scroll)) - 0.5) * FogParams`), light + add the emissive, then additively
   *  composite the chr_f01 flame wisps. The former composite/distort split was spurious -
   *  meramon and birdramon run the byte-identical body fp (RE: capture eid 573 == 470),
   *  so both take this path. NOT the unlit `CHR_HAS_UV_DISTORT` eff-fire boil. */
  hasFlowOverlay: boolean;
  /** The canonical noise-distortion layer: the mesh's diffuse (the `chr_f` flame
   *  atlas) is warped by a scrolling flow-noise (the `Bumpiness` `chr_fNNn` atlas
   *  + `ScrollSpeedSet2U`). Compiles the distortion into the diffuse UV: `uv +=
   *  (noise(uv1 + frac(time*scroll)) - 0.5) * distort`. This is the fire flame-boil
   *  ("boil") - a sibling of the `UvScrollEffect` offset-walk scroll layer
   *  (`ScrollSpeedSet1U`); the two compose here, they are not merged. Off for every
   *  mesh without the noise/scroll signature, so the toon body path is unchanged.
   *  The fire churn family renders through this ubershader path, not a separate
   *  fire shader. */
  hasUvDistort: boolean;
  /** The flame diffuse (albedo + alpha) is modulated by the mesh's per-vertex
   *  `COLOR_0` stream. The fb_02 head-fireball layer (0xcef1bb79) runs a chr
   *  ubershader variant whose fp does `r0.xyzw *= v0.xyzw` (the vp passes COLOR_0
   *  straight through); the sibling fb_01 program does not read vertex color.
   *  Declared by the catalog's `vertexColor` compose flag, gated on the mesh
   *  carrying the attribute. Emits `USE_COLOR_ALPHA` so three declares
   *  `attribute vec4 color;`. See notes/fb01-fireball-recipe.md. */
  hasVertexColor: boolean;
  /** Degamma the vertex colour before it modulates albedo (chr805) - see
   *  `vertexColorGamma` in recipes/types.ts. Only meaningful with hasVertexColor. */
  hasVertexColorGamma: boolean;
  /** Unlit, emissive-only additive core: output ONLY the emissive term
   *  (`em x EmissiveIntensity x EmissiveSampler`), skipping albedo / lighting /
   *  toon and the cover-fray dither. The fb_03/fb_04 inner cores (0xb9f68bef /
   *  0x27921e4c) run a distinct simpler program (cb0[10], no SH/fresnel/fog) the
   *  ubershader catch-all would over-light; they lack the uv-distort signature so
   *  they'd otherwise take the LIT body path. Declared by the catalog's
   *  `unlitEmissive` compose flag; pairs with the baked `blend_op:'add'`. */
  hasUnlitEmissive: boolean;
  /** Add the eff-card program's FLAT constant emissive (`EmissiveColor.rgb x
   *  EmissiveIntensity`, no atlas). Set by the `flatEmissive` compose flag. */
  hasFlatEmissive: boolean;
  /** Like `hasFlatEmissive`, but the flat constant is the ONLY colour - albedo is
   *  dropped (colour starts black, the diffuse RGB is never added). The MachGaogamon
   *  jet-vent cards whose fp binds a white dummy for alpha only. Set by the
   *  `flatEmissiveOnly` compose flag. */
  hasFlatEmissiveOnly: boolean;
  /** Eff-card composite: run the ordered dither AND output the real alpha for the
   *  survivors (`o0.w = mask * alpha`), rather than discarding into an opaque
   *  surface. Set by the `ditherBlend` compose flag. */
  hasDitherBlend: boolean;
  /** Light the mesh by SH ambient ALONE - unlit albedo plus the ambient term, with
   *  no toon direct, no rim and no fill. Set by the `unlit` compose flag. */
  hasUnlit: boolean;
  /** Camera-facing billboard (fb_02): rebuild the vertex position on the camera
   *  basis at the attach bone instead of the bone's rotation, so the layer always
   *  faces the viewer (the game vp's cb0[5]/[6]/[7] basis map). Requires skinning
   *  (the bone world transform is read from the skin matrix). Declared by the
   *  catalog's `billboard` compose flag. See notes/fb01-fireball-recipe.md. */
  hasBillboard: boolean;
  /** The jet-flame program (MachGaogamon `e_505`/`e_515`, 0x50343a80 / 0x492f0bc1).
   *  UNLIT: colour is the emissive gradient ALONE (`em.rgb x EmissiveIntensity x
   *  EmissiveSampler`, no albedo, no SH/toon/rim/fill); the baseColor map is the
   *  flame SHAPE, taken as ALPHA ONLY and sampled at `uv0 + an animated vertical
   *  scroll` (off the shared fire clock). A reverse-fresnel term (`ndotv` in the
   *  numerator - opaque face-on, fading at grazing angles) modulates that alpha,
   *  which then feeds the `CHR_HAS_DITHER_BLEND` screen door. Set by the `flame`
   *  compose flag; pairs with `ditherBlend`. RE: fp `fs.105a6b5e` r2 block. */
  hasFlame: boolean;
  /** Galaxy portal: the baseColor map (`chr604a06` starfield) is sampled in
   *  SCREEN space instead of on the mesh UV, so the stars stay fixed to the view
   *  while the mesh moves through them - a window into a scrolling starfield
   *  (GraceNovamon cape + core/hand spheres, 0x0944ec89). RE'd from the field-guide
   *  captures: the game VS builds the star UV as `clip.xy / clip.w` (NDC) + a slow
   *  time-scroll (TEXCOORD4 = NDC + frac(time * ScrollSpeedSet2U)); the mesh is only
   *  the mask. We replicate the per-vertex NDC as a varying (`vStarUv`) so three's
   *  perspective interpolation matches the game's, then override the diffuse UV with
   *  it. Set by the catalog's `galaxyStars` compose flag; requires a bound map. */
  hasGalaxyStars: boolean;
  /** Wing scroll overlay (GraceNovamon wing, 0x47fdfabb): the base body atlas
   *  (`chr604a02`) gets two additive `chr604a04em` overlay layers composited on top,
   *  each sampled at the mesh UV + its own independent time-scroll (ScrollSpeedSet2U /
   *  ScrollSpeedSet3U) and weighted by its own alpha x OverlayStrength3 - the
   *  "scrolling squares". RE'd from draw 547 (color = a02 + a04em#1.rgb*(a04em#1.a*s1)
   *  + a04em#2.rgb*(a04em#2.a*s2)). The base (a02) rides CHR_HAS_MAP and the cyan
   *  emissive (`a02em`) rides CHR_HAS_EMISSIVE; this feature adds ONLY the two animated
   *  overlays. Resolved at load (wingScroll.ts / getWingScroll). */
  hasWingScroll: boolean;
  /** Gallantmon (X) sword energy: the base $ColorSampler particle sprite (chr358eff01
   *  white + spiky shaped-alpha) scrolls, so the spark shapes flow along the blade/hilt.
   *  The game VS offsets uv0 by frac(time * ScrollSpeedSet); this drives the same
   *  in-shader base-UV scroll off the shared fire clock. Pairs with the catalog's
   *  alphaBlend (the particle's alpha is the coverage; the cyan is the eff*em emissive). */
  hasEffScroll: boolean;
  /** Gallantmon (X) sword energy: the ScratchBorder dissolve mask (chr358eff*m) breaks
   *  the base particle's opaque band into the grainy/spiky energy shape (the fp's cover
   *  branch, cb0[28].y > 0.5, GPU-confirmed live at rest). Its LUMINANCE modulates the
   *  output alpha - the shape is in the mask's RGB, its alpha is opaque. Rides the same
   *  scrolling base UV. Resolved at load (effMask.ts / getEffMask). */
  hasEffMask: boolean;
  /** Gallantmon (X) sword energy: binary Bayer/17 screen-door stipple on the output
   *  alpha (coverage = particle alpha x emissive alpha), not a smooth blend. Set by the
   *  `screenDoor` compose flag; drives CHR_HAS_EFF_SCREEN_DOOR. See chrCel.glsl.ts. */
  hasEffScreenDoor: boolean;
  /** This mesh's game program runs an UNGATED alpha test - a hard `discard` below a
   *  threshold, outside the cover/dissolve branch (data/alpha_test_shader_hashes.json,
   *  60 programs; e.g. skullseadramon's `fin` 0x52d10dce). It is a SEPARATE mechanism
   *  from the Bayer screen door, not an alternative to it: 56 of the 60 run both, back
   *  to back on the same alpha - hard-cut the fully transparent texels, then stipple
   *  the partials. Drives CHR_HAS_ALPHA_TEST + `uAlphaTest`. See chrCel.ts. */
  hasAlphaTest: boolean;
}

// Exposure on the substituted direct-light term. The studio rig's directional
// intensities (~2.1 key) are calibrated for PBR/IBL; multiplied flat into the
// toon band they blow out, so we tame them here. The headline brightness knob -
// nudge if the lit side clips.
const DIRECT_EXPOSURE = 1.0;

// Self-shadow application, transcribed from the chr ubershader rather than
// invented. The engine does NOT scale a light by a shadow mask; it re-looks-up
// the CLUT toon ramp toward the ramp's shadow end and lerps by the shadow term
// (guil fp asm 473-477), then attenuates the whole composite by a lerp between
// an authored floor and 1.0 (asm 424-425, consumed at 819-831). Two consequences
// the naive "multiply the light" form gets wrong: shadowed pixels stay ON the
// ramp (so they keep cel banding and the ramp's authored shadow hue instead of
// picking up a smooth grey gradient), and they bottom out around half rather
// than at black.
//
// `RAMP_SHADOW_U` is the literal U the asm samples the shadow end at
// (`l(4.99999523e-03)`). `SHADOW_FLOOR` is cb0[1023], captured as [0.498]^3 on
// the bacchusmon chr179 body (bacchusmon_f7188.rdc = Field Guide #389).
//
// Sign note: the asm's accumulator is 1-at-occluded (reverse-Z compare), which is
// why both its uses read as "lit" - the ramp lerp goes shadow-end -> lit sample,
// and the floor lerp goes SHADOW_FLOOR -> 1.0. Only that reading makes the two
// consistent. three's getShadowMask() is 1-at-lit, so it drops straight into both
// without inversion.
const RAMP_SHADOW_U = 0.005;
const SHADOW_FLOOR = 0.498;

// Inner-glow-A rim strength. The asm adds this fresnel rim UNCONDITIONALLY
// (gA * rim color, tinted by the toon ramp), and it is a real in-game effect - a
// view-locked soft highlight that masks the hard silhouette, confirmed against the
// Lucemon-SM orb (a sphere, whose fresnel reads as a static edge circle). So
// `uGlowRimScale` DEFAULTS TO 1 (faithful), exposed as the editor's Glow-rim
// toggle for opt-out.
//
// What keeps most chrs subtle is the authored rim COLOR, not the geometry or the
// mask: the roster's stamped value is overwhelmingly a dark neutral [0.2,0.2,0.2],
// with only ~77 materials authored bright (white [1,1,1] on Examon/BlackWarGreymon,
// an HDR orange [5,2,0] on Jupitermon-WM's effect mesh). Reading the rim color off
// the wrong uniform is what once painted a white 1.2x rim over the whole roster -
// see the rim-color block in chrCel.ts for the capture that pins the right one.
//
// The rim is additionally masked by the `a01s` spec-atlas alpha (asm 777) ON
// MATERIALS THAT BIND IT (BackBufferSampler); see the `hasSpecMask` block below.

// Normal-map sign conventions. The chr ubershader reconstructs N in WORLD space
// from interpolated TBN basis varyings (guil_fp.asm 94-111) - the same approach
// taken here - and applies NO green-channel negation (the sampled normal feeds
// straight into `x*T + y*B` after a centering bias), so `a01n` follows the
// OpenGL/glTF green-up convention: standard `sample*2-1`, no Y flip. The
// bitangent handedness comes from the game's verbatim `tangent.w` via the glTF
// reconstruction `B = cross(N,T)*w`. Whether the game's w-sign matches that
// convention is the one axis the static data can't settle (see
// TANGENT-EXPORT-NOTE.md "Handedness caveat") - if normal-mapped surfaces read
// inverted, flip the sign here (Dorugamon's gem facets are the visual probe).
const NORMAL_MAP_FLIP_GREEN = false;
const TANGENT_W_SIGN = 1.0;

// v1 scope: the engine blends a PRIMARY + a secondary detail normal map with
// data-driven cb0[1018]/cb0[1020] scales. v1 wires only the primary (`a01n`,
// three's `normalMap`) at the glTF-neutral unit scale (material.normalScale),
// mirroring how shadows / extra lights were scoped out. The detail layer and the
// exact captured scales are a v1.5 refinement.

const f = (n: number): string => {
  // Emit a GLSL float literal (always with a decimal point).
  const s = String(n);
  return s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`;
};

/** The Bayer 4x4 matrix as a flat GLSL const array initializer (row-major,
 *  indexed [ix*4+iy] to match bayerThreshold). */
const bayerGLSL = (): string => {
  const flat: number[] = [];
  for (let ix = 0; ix < 4; ix++) for (let iy = 0; iy < 4; iy++) flat.push(BAYER17[ix][iy]);
  return flat.map(f).join(', ');
};

/** The toon band function - the game's actual global toon ramps, baked by
 *  `exporter export-assets` and loaded once into the rig (deps.celClut ->
 *  uCLUT/uCLUTFill). Returns a per-channel light MULTIPLIER (vec3); the caller
 *  multiplies it by the light color.
 *
 *  Sampled at `toonRampU(NdotL)` = the game's `wrap*0.495+0.5` remap. Per-LIGHT
 *  ramp split (core-fcbd6588e974 asm 448-453 vs 583/646/731): the game's
 *  DIRECTIONAL loop samples t6 = common_clut (neutral, 0.5->1.0); its
 *  point/probe/spot loops sample t7 = clut001 (COOL, (5,1,16)->0.61) - the source
 *  of the game's cool shadows. The viewer rig has only directional lights, so we
 *  map the analog by role: the KEY light (index 0) -> neutral uCLUT, FILL lights
 *  (index >=1) -> cool uCLUTFill. Shadows (where the key drops off and the fill
 *  dominates) then read cool, like the game.
 *
 *  Both ramps are V-flat (1D on NdotL), so V is a constant (the game's V = 1-NdotH
 *  is a no-op here). Samplers are declared in the helper block (it precedes the
 *  fragment's uniform list); they're NoColorSpace data ramps (celClut.ts), baked
 *  into the glb and resolved per-model before the first render (viewer.ts). */
const TOON_BAND_GLSL = `uniform sampler2D uCLUT;
uniform sampler2D uCLUTFill;
vec3 toonBandAtU(float u, int lightIndex) {
  if (lightIndex == 0) return texture2D(uCLUT, vec2(u, 0.5)).rgb;
  return texture2D(uCLUTFill, vec2(u, 0.5)).rgb;
}
vec3 toonBand(float ndotl, int lightIndex) {
  return toonBandAtU(clamp(toonRampU(ndotl), 0.0, 1.0), lightIndex);
}`;

/** Shared GLSL helper block - the math.ts functions transcribed 1:1, with the
 *  literals templated from the TS source of truth, plus the CLUT toon band. */
const helpers = (): string => `
const float ACOS_C0 = ${f(ACOS_C0)};
const float ACOS_C1 = ${f(ACOS_C1)};
const float ACOS_C2 = ${f(ACOS_C2)};
const float ACOS_C3 = ${f(ACOS_C3)};
const float TWO_OVER_PI = ${f(TWO_OVER_PI)};
const float INV_PI = ${f(INV_PI)};
const float SH_L0 = ${f(SH_L0)};
const float SH_L1 = ${f(SH_L1)};
const float SH_L2_CROSS = ${f(SH_L2_CROSS)};
const float SH_L2_M0 = ${f(SH_L2_M0)};
const float SH_L2_M2 = ${f(SH_L2_M2)};

// acos(x) approximation. (see README: Toon ramp)
float acosApprox(float x) {
  float ax = abs(x);
  float s = sqrt(max(0.0, 1.0 - ax));
  float p = ((ACOS_C3 * ax + ACOS_C2) * ax + ACOS_C1) * ax + ACOS_C0;
  float q = s * p;
  return x < 0.0 ? (3.14159265 - q) : q;
}

// Toon-ramp lookup coordinate from NdotL. (see README: Toon ramp)
float toonRampU(float ndotl) {
  float wrap = 1.0 - acosApprox(clamp(ndotl, -1.0, 1.0)) * TWO_OVER_PI;
  return wrap * ${f(TOON_U_SCALE)} + ${f(TOON_U_BIAS)};
}

${TOON_BAND_GLSL}

// Order-2 spherical-harmonic ambient. (see README: Ambient light)
vec3 evalSH9(vec3 sh[9], vec3 n) {
  vec3 L1 = -(n.x * sh[3] + n.y * sh[1] + n.z * sh[2]);
  vec3 CROSS = n.x * n.y * sh[4] + n.y * n.z * sh[5] + n.x * n.z * sh[7];
  return SH_L0 * sh[0]
       + SH_L1 * L1
       + SH_L2_CROSS * CROSS
       + SH_L2_M0 * (3.0 * n.z * n.z - 1.0) * sh[6]
       + SH_L2_M2 * (n.x * n.x - n.y * n.y) * sh[8];
}

// Fresnel rim-glow, curve A. (see README: Rim glow)
float innerGrowA(float ndotv, vec3 base) {
  float fres = 1.0 - ndotv;
  float ratio = max(fres / (base.x * ndotv + fres), 0.0);
  float bias = (base.z == 1.0) ? -0.999 : -base.z;
  float t = max(ratio * base.y + bias, 0.0);
  return clamp(t / (bias + 1.0), 0.0, 1.0);
}

// Fresnel rim-glow, curve B. (see README: Rim glow)
float innerGrowB(float ndotv, vec3 base) {
  float fres = 1.0 - ndotv;
  float ratio = max(fres / (base.x * ndotv + fres), 0.0);
  float zb = min(base.z, 0.999);
  return min(max(ratio * base.y - zb, 0.0) / (1.0 - zb), 1.0);
}

// Reverse-fresnel alpha falloff for the jet-flame card (fp fs.105a6b5e r2 block).
// Unlike innerGrowA/B (edge-high: fres in the numerator), the numerator here is
// ndotv, so the term is HIGH facing the camera and fades toward the silhouette -
// the flame reads opaque head-on and softens at grazing angles. Shape verbatim from
// the asm: ratio = ndotv / (sub*(1-ndotv) + ndotv); a = clamp((ratio*range - z)/(1-z)).
// sub/range are the ReverseFresnelSub / ReverseFresnelRange uniforms; z (the
// bias, cb0[3].z) is not a named uniform here and defaults to 0 (RimLightColor = 0).
float flameFresnel(float ndotv, float sub, float range, float z) {
  float fres = 1.0 - ndotv;
  float ratio = max(ndotv / (sub * fres + ndotv), 0.0);
  float num = max(ratio * range - z, 0.0);
  float den = max(1.0 - z, 1e-4);
  return min(num / den, 1.0);
}

// Hard-light contrast blend of a reflection layer over a base color. (see README:
// Environment reflection) A single whole-pixel branch on the blend layer's summed
// brightness picks multiply (2*base*blend) below the midpoint or screen above it,
// so the base HUE is preserved and only its contrast is shaped by the reflection.
vec3 chrHardLight(vec3 base, vec3 blend) {
  vec3 mult = 2.0 * base * blend;
  vec3 scrn = 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
  return (blend.x + blend.y + blend.z) < 1.5 ? mult : scrn;
}
`;

/** Vertex shader: three-owned chunks; skinning gated by the USE_SKINNING
 *  define so bone animation on a SkinnedMesh stays free. The diffuse UV set is
 *  chosen to match the live game shader's texcoord routing (see below). */
export function buildChrCelVertex(): string {
  return `
#include <common>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
varying vec2 vChrUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vViewDirW;
#ifdef CHR_HAS_NORMAL_MAP
varying vec3 vWorldTangent;
varying float vTangentW;
#endif
#ifdef CHR_HAS_BODY_OVERLAY
varying vec2 vOverlayUv;
#endif
#ifdef CHR_HAS_FLOW_OVERLAY
varying vec2 vFlowUvB;
#endif
#ifdef CHR_HAS_UV_DISTORT
varying vec2 vFireNoiseUv;
#endif
#ifdef CHR_HAS_EFF_MASK
varying vec2 vEffMaskUv;          // Gallantmon (X) sword energy: the mask rides UV1 (TEXCOORD_1),
                                  // scrolled independently of the base in the fragment
#endif
#ifdef CHR_HAS_GALAXY_STARS
// Per-vertex NDC (clip.xy / clip.w) - the game's screen-space star UV base. three
// perspective-interpolates it, matching the game's TEXCOORD4 interpolation.
varying vec2 vStarUv;
#endif
#ifdef CHR_HAS_VERTEX_COLOR
// three declares the vec4 color attribute under USE_COLOR_ALPHA (emitted alongside
// this guard); pass it through to modulate the flame diffuse in the fragment.
varying vec4 vChrColor;
#endif
#ifdef CHR_HAS_MAP
uniform vec2 uMapOffset;
uniform vec2 uMapRepeat;
#endif
#ifdef CHR_HAS_EMISSIVE
varying vec2 vEmUv;
uniform vec2 uEmOffset;
uniform vec2 uEmRepeat;
#endif
#ifdef CHR_HAS_BILLBOARD
// The attach bone's LIVE world transform, fed per-frame by BillboardEffect from
// skeleton.bones[dsts_render.billboard.bone].matrixWorld (bone reconstruction
// in-shader can't survive the meshopt bind chain). Origin = bone world position,
// scale = bone world per-axis scale.
uniform vec3 uBillboardOrigin;
uniform vec3 uBillboardScale;
#endif
void main() {
#ifdef CHR_HAS_EMISSIVE
  // Emissive UV - routed by the em atlas's own channel, with its offset/repeat.
  // (see README: Vertex: UV routing)
  #if defined(CHR_EM_UV) && CHR_EM_UV == 2
    vec2 emBase = uv2;
  #elif defined(CHR_EM_UV) && CHR_EM_UV == 1
    vec2 emBase = uv1;
  #else
    vec2 emBase = uv;
  #endif
  vEmUv = emBase * uEmRepeat + uEmOffset;
#endif
#ifdef CHR_HAS_MAP
  // Diffuse / eye-overlay UV - selected by the map's own channel (CHR_MAP_UV),
  // with its offset/repeat. (see README: Vertex: UV routing)
  #if defined(CHR_MAP_UV) && CHR_MAP_UV == 2
    vec2 chrMapUv = uv2;
  #elif defined(CHR_MAP_UV) && CHR_MAP_UV == 1
    vec2 chrMapUv = uv1;
  #else
    vec2 chrMapUv = uv;
  #endif
  vChrUv = chrMapUv * uMapRepeat + uMapOffset;
#else
  vChrUv = uv; // map-less mesh: identity UV0
#endif
#ifdef CHR_HAS_BODY_OVERLAY
  vOverlayUv = uv1; // layer 2 rides UV1 (the engine's v5)
#endif
#ifdef CHR_HAS_FLOW_OVERLAY
  // The flow-noise rides UV1 (the fragment scrolls it). RE: the meramon flame-body VS
  // (capture eid 573) builds the noise UV as TEXCOORD1 + frac(time * ScrollSpeedSet2U);
  // the flesh/em ride UV0. UV1 spans multiple cycles (V ~= -1..2 on meramon/megidramon)
  // - that multi-cycle tiling IS the game's intended boil spatial frequency, independent
  // of the albedo unwrap.
  vFlowUvB = uv1;
#endif
#ifdef CHR_HAS_UV_DISTORT
  vFireNoiseUv = uv1; // flow-noise layer rides UV1 (fragment scrolls + samples it)
#endif
#ifdef CHR_HAS_EFF_MASK
  // Gallantmon (X) sword energy: the dissolve mask rides UV1 (the game VS builds
  // TEXCOORD4 = uv1 + frac(time*Set2U); the base color rides uv0/TEXCOORD3). The
  // fragment applies the independent Set2U scroll, so pass the raw uv1 through here.
  vEffMaskUv = uv1;
#endif
#ifdef CHR_HAS_VERTEX_COLOR
  vChrColor = color; // per-vertex COLOR_0 (fb_02 flame modulation)
#endif
  vec3 objectNormal = normalize(normal);
#ifdef CHR_HAS_NORMAL_MAP
  // Game-authored tangent (xyz + handedness w), skinned with the normal so the
  // TBN survives bone deformation. (see README: Vertex: skinning)
  vec3 objectTangent = vec3(tangent.xyz);
#endif
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  vec3 transformed = position;
  #include <skinning_vertex>
#ifdef CHR_HAS_BILLBOARD
  // Camera-facing billboard (fb_02). The game vp (0xcef1bb79) builds each vertex as
  //   worldPos = boneOrigin + (v0 rotated onto the camera basis) * boneScale
  // where the basis (cb0[5]/[6]/[7] = world right/up/forward) makes the quad face
  // the viewer and its local Z fold toward the camera (reads as a flat ring from any
  // angle), and boneOrigin / boneScale come from the attach bone's world matrix.
  // We take the attach bone's live transform from the uBillboard* uniforms (fed each
  // frame by BillboardEffect) because the in-shader bone reconstruction can't survive
  // the meshopt bind chain. The object-space quad v0 is the meshopt-quantized
  // position attribute dequantized by modelMatrix (this mesh sits at the origin in
  // bind pose; its local matrix IS the dequant scale/offset). Fire is unlit, so the
  // normal is just the camera facing.
  vec3 objQuad = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camFwd   = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 rotated = camRight * objQuad.x + camUp * objQuad.y + camFwd * objQuad.z;
  vec3 billboardPos = uBillboardOrigin + rotated * uBillboardScale;
  vec4 worldPos = vec4(billboardPos, 1.0);
  vec4 mvPosition = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mvPosition;
  vWorldNormal = normalize(-camFwd);
#else
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
  vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
#endif
  vWorldPos = worldPos.xyz;
#ifdef CHR_HAS_NORMAL_MAP
  vWorldTangent = normalize(mat3(modelMatrix) * objectTangent);
  vTangentW = tangent.w;
#endif
  vViewDirW = cameraPosition - worldPos.xyz;
  // Shadow-receive coords from the skinned world position. (see README: Vertex: skinning)
  vec3 transformedNormal = normalMatrix * objectNormal;
  vec4 worldPosition = worldPos;
  #include <shadowmap_vertex>
#ifdef CHR_HAS_GALAXY_STARS
  // Screen-space star UV base: NDC (perspective divide of clip space). The game
  // builds this per-vertex in its VS and interpolates it; we mirror that. NDC.x spans
  // the wider screen dimension, so we aspect-correct it (x *= width/height, read off the
  // projection matrix) to keep the star tiles SQUARE instead of stretched horizontally.
  vec2 chrNdc = gl_Position.xy / gl_Position.w;
  float chrAspect = projectionMatrix[1][1] / projectionMatrix[0][0]; // = width / height
  vStarUv = vec2(chrNdc.x * chrAspect, chrNdc.y);
#endif
}
`;
}

/** Fragment shader (the transcription). */
export function buildChrCelFragment(): string {
  return `
${helpers()}
// Shadow-receive machinery: three's own shadow map feeds the SHADOW_FACTOR seam
// via getShadowMask(). (see README: Direct lighting)
#include <common>
#include <packing>
#include <shadowmap_pars_fragment>
uniform bool receiveShadow;
#include <shadowmask_pars_fragment>

uniform vec4 uDiffuseAlpha;      // diffuse tint x alpha
uniform vec3 uInnerGrowAColor;   // rim-glow color
uniform vec3 uInnerGrowABase;    // rim-glow curve [exp, scale, mode]
uniform vec3 uInnerGrowBColor;   // rim-glow color B
uniform vec3 uSH[9];             // SH ambient coefficients
uniform float uShScale;          // SH ambient scale
uniform vec3 uFill;              // flat fill add
uniform vec3 uLightDirs[${MAX_RIG_LIGHTS}];
uniform vec3 uLightColors[${MAX_RIG_LIGHTS}];
uniform int uNumLights;
uniform vec3 uFogColor;          // fog color
uniform float uFogAmount;        // fog amount
uniform float uGlowBlend;        // rim-glow blend
uniform float uGlowRimScale;     // editor Glow-rim slider (0 = off)
uniform float uAlphaBlend;       // 1 = smooth per-pixel alpha blend (visor/wing/glass)
uniform float uHasCover;         // 1 = mesh carries CoverSampler (cover/dissolve threshold)
uniform float uProgramDithers;   // 1 = this mesh's game program implements the Bayer dither
#ifdef CHR_HAS_ALPHA_TEST
uniform float uAlphaTest;        // ungated hard-discard cutoff on the combined alpha (cb0[0].x)
#endif
#ifdef CHR_HAS_MAP
uniform sampler2D uMap;
#endif
#ifdef CHR_HAS_SPEC_MASK
uniform sampler2D uSpecMap;
#endif
#ifdef CHR_HAS_NORMAL_MAP
uniform sampler2D uNormalMap;
uniform vec2 uNormalScale;
#endif
#ifdef CHR_HAS_BODY_OVERLAY
uniform sampler2D uBodyOverlay;
uniform float uOverlayStrength;
uniform vec2 uOverlayScroll;   // UV1-layer scroll velocity (ScrollSpeedSet2U); [0,0] = static
uniform float uOverlayTime;    // shared clock; frac(uOverlayTime*uOverlayScroll) offsets the layer
varying vec2 vOverlayUv;
#endif
#ifdef CHR_HAS_OVERLAY_L3
// Layer 3. No varying of its own: it samples the DIFFUSE UV (engine v4), the same
// coordinate the base atlas uses, so it reads vChrUv directly.
uniform sampler2D uOverlayL3;
uniform float uOverlayL3Strength;
#endif
#ifdef CHR_HAS_PHANTOM_GROW
// The $PhantomGrowTexture layer. Reuses vWorldPos/vWorldNormal - it projects in
// WORLD space, which is why it reads as sitting UNDER the model and rolling
// through it rather than sliding across its UVs.
uniform sampler2D uGrowMap;   // engine global; the capture bound a 64x8 all-white dummy
uniform vec3 uGrowTint;       // cb0[1053].xyz - measured [0.498, 0.498, 0.498] (white)
uniform float uGrowScale;     // cb0[1054].w   - world-space projection scale (0.0006)
uniform vec2 uGrowOffset;     // cb0[1054].xy  - animated by ScrollSpeedSet2U * time
uniform float uGrowStrength;  // 1 - saturate(cb0[1049].y); 0 = absent, the default
// One planar slice of the projection: scale world units into texture space and
// add the scrolling offset. The engine does (worldPos + offset) * scale.
vec2 vGrowUv(vec2 planar) { return (planar + uGrowOffset) * uGrowScale; }
#endif
#ifdef CHR_HAS_FLOW_OVERLAY
uniform sampler2D uFlowNoise;    // chr_fNNn flow-noise (OverlayDistortion slot) - warps flesh + em
uniform float uFlowNoiseStrength;// flesh + em UV warp magnitude (the boil turbulence)
uniform float uFlowTime;         // shared fire clock (viewer advances it)
uniform vec2 uFlowScrollB;       // noise scroll velocity (ScrollSpeedSet2U, the moving churn octave)
uniform float uFlowOverlayScale; // Flames toggle: 1 = boil on, 0 = clean lit skin
uniform sampler2D uFlowFlame;    // chr_f01 flame atlas (OverlayNormalSampler) - additive wisps
uniform float uFlowFlameIntensity;// wisp opacity (fp cb0 m[5].z); 0 when no flame atlas
uniform float uFlowFlameWarp;    // wisp domain-warp strength (fp cb0 m[5].w)
varying vec2 vFlowUvB;
#endif
#ifdef CHR_HAS_GALAXY_STARS
uniform float uStarTime;         // shared fire clock (viewer advances it)
uniform vec2 uStarScroll;        // screen-space scroll velocity (ScrollSpeedSet2U)
uniform float uStarScale;        // NDC->star-UV tiling (1 = game-faithful density)
varying vec2 vStarUv;            // per-vertex NDC, perspective-interpolated
#endif
#ifdef CHR_HAS_WING_SCROLL
uniform sampler2D uWingOverlay;  // chr604a04em overlay atlas (sampled twice)
uniform float uWingTime;         // shared fire clock (viewer advances it)
uniform vec2 uWingScroll1;       // overlay layer 1 scroll velocity (ScrollSpeedSet2U)
uniform vec2 uWingScroll2;       // overlay layer 2 scroll velocity (ScrollSpeedSet3U)
uniform float uWingStrength;     // per-layer additive weight (OverlayStrength3)
uniform float uWingTile;         // overlay UV tiling (repeat count across the wing UV)
#endif
#ifdef CHR_HAS_EFF_SCROLL
uniform float uEffTime;          // shared fire clock (viewer advances it)
uniform vec2 uEffScroll;         // base particle scroll velocity (ScrollSpeedSet)
#endif
#ifdef CHR_HAS_EFF_MASK
uniform sampler2D uEffMask;      // ScratchBorder dissolve mask (chr358eff*m); shape in RED
uniform float uEffMaskThreshold; // hard-discard cutoff on the mask RED channel (fp _child34.x=0.711)
uniform float uEffMaskTime;      // shared fire clock (drives the INDEPENDENT mask scroll)
uniform vec2 uEffMaskScroll;     // mask scroll velocity (ScrollSpeedSet2U) - separate from the base
#endif
#if defined(CHR_HAS_EMISSIVE) || defined(CHR_HAS_FLAT_EMISSIVE) || defined(CHR_HAS_FLAT_EMISSIVE_ONLY)
uniform vec3 uEmissive;
uniform float uEmissiveStrength;
#endif
#ifdef CHR_HAS_EMISSIVE
uniform sampler2D uEmissiveMap;
varying vec2 vEmUv;
#endif
#ifdef CHR_HAS_FLAME
uniform float uFlameTime;        // shared fire clock (viewer advances it)
uniform float uFlameScroll;      // vertical mask-scroll velocity (approximates OffsetSet1U)
uniform float uFlameFresnelSub;  // ReverseFresnelSub  (fp cb0[3].x, denom coeff on 1-ndotv)
uniform float uFlameFresnelRange;// ReverseFresnelRange (fp cb0[3].y, ratio multiplier)
#endif
#ifdef CHR_HAS_ENV_REFLECT
uniform samplerCube uEnvCube;
uniform sampler2D uReflectMask;
uniform float uReflectIntensity;
uniform float uReflectStrength;
#endif
#ifdef CHR_HAS_UV_DISTORT
uniform sampler2D uFireNoise;    // chr_fNNn flow-noise atlas (Bumpiness slot)
uniform float uFireTime;         // shared fire clock (viewer advances it)
uniform vec2 uFireScroll;        // ScrollSpeedSet2U - noise-layer scroll velocity
uniform float uFireDistort;      // warp strength (fragment cb0, ~0.8)
uniform float uFireBlend;        // 0 = opaque core (B, alpha-test), 1 = soft body (A)
varying vec2 vFireNoiseUv;
#endif
#ifdef CHR_HAS_EFF_MASK
varying vec2 vEffMaskUv;          // mask UV1 (the fragment adds the independent Set2U scroll)
#endif
#ifdef CHR_HAS_VERTEX_COLOR
varying vec4 vChrColor;           // per-vertex COLOR_0 - modulates the flame diffuse (fb_02)
#ifdef CHR_HAS_VERTEX_COLOR_GAMMA
uniform float uVertexColorGamma;  // degamma exponent on vChrColor.rgb (chr805)
#endif
#endif

varying vec2 vChrUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vViewDirW;
#ifdef CHR_HAS_NORMAL_MAP
varying vec3 vWorldTangent;
varying float vTangentW;
#endif

void main() {
#ifdef CHR_HAS_FLOW_OVERLAY
  // The boil warp offset, set with the flesh UV below and reused for the emissive so
  // the glow churns with the body: the flaming-skin body fp (meramon / birdramon /
  // centarumon / ...) warps the flesh AND the emissive sampling UV by ONE distortion
  // field (RE: the body fp samples t1 flesh + t2 em at the same warped UV), then adds
  // the emissive and composites the chr_f01 flame wisps.
  vec2 chrFlowWarp = vec2(0.0);
#endif
  // Diffuse / albedo. (see README: Diffuse color)
#ifdef CHR_HAS_MAP
  vec2 chrDiffuseUv = vChrUv;
  #ifdef CHR_HAS_UV_DISTORT
  // Fire flame-boil: warp the flame diffuse UV by the scrolling flow-noise so the
  // toon-banded flame morphs (the eff fp's noise-distortion, recovered from the
  // capture): flameUV = uv0 + (noise(uv1 + frac(time*scroll)) - 0.5) * distort.
  vec2 fireNoiseUv = vFireNoiseUv + fract(uFireTime * uFireScroll);
  vec2 fireFlow = texture2D(uFireNoise, fireNoiseUv).xy - 0.5;
  chrDiffuseUv += fireFlow * uFireDistort;
  #endif
  #ifdef CHR_HAS_FLOW_OVERLAY
  // Boiling body: warp the flesh (and, below, the emissive) sampling UV by the
  // scrolling distortion field (chr_fNNn read at the ScrollSpeedSet2U octave). This
  // churn IS the fire look. The noise UV is UV1 + frac(time * scroll); the warp
  // magnitude is the per-material FogParams uniform (uFlowNoiseStrength). The Flames
  // toggle (uFlowOverlayScale) stills the churn without hiding the body. This ONE flow
  // branch serves every flaming-skin body (the former composite/distort split was
  // spurious - meramon and birdramon run the byte-identical body fp; RE eid 573/470).
  chrFlowWarp = (texture2D(uFlowNoise, vFlowUvB + fract(uFlowTime * uFlowScrollB)).xy - 0.5)
                * (uFlowNoiseStrength * uFlowOverlayScale);
  chrDiffuseUv += chrFlowWarp;
  #endif
  #ifdef CHR_HAS_FLAME
  // Jet-flame mask scroll: the flame SHAPE lives in the mask (uMap.a) and scrolls
  // vertically each frame (the game VS adds cb0._child4 ~ (0, 1.843) to t0's uv0);
  // the colour gradient (uEmissiveMap, vEmUv) is sampled STATIC. Continuous scroll
  // off the shared fire clock approximates the per-frame OffsetSet1U track the
  // extractor does not yet export. Only V scrolls (the flame licks upward).
  chrDiffuseUv += vec2(0.0, fract(uFlameTime * uFlameScroll));
  #endif
  #ifdef CHR_HAS_EFF_SCROLL
  // Gallantmon (X) sword energy: scroll the base particle sprite so the spark shapes
  // flow along the blade/hilt (the game VS offsets uv0 by frac(time*ScrollSpeedSet)).
  // The particle's ALPHA is the coverage (alpha-blended), so scrolling moves the sparks.
  chrDiffuseUv += fract(uEffTime * uEffScroll);
  #endif
  #ifdef CHR_HAS_GALAXY_STARS
  // Galaxy portal: OVERRIDE the mesh UV with the screen-space (NDC) star UV + a slow
  // time-scroll, so the starfield is fixed to the view and the mesh reads as a window
  // into it (RE: game VS TEXCOORD4 = NDC + frac(time * ScrollSpeedSet2U)). The map wraps.
  chrDiffuseUv = vStarUv * uStarScale + fract(uStarTime * uStarScroll);
  #endif
  vec4 tex = texture2D(uMap, chrDiffuseUv);
#ifdef CHR_HAS_EFF_MASK
  // Gallantmon (X) sword-energy dissolve - the faithful mechanism (GPU-confirmed from the
  // captured aura fp SPIR-V, gallantmon-x_quiet-a eid 558): the ScratchBorder mask rides
  // its OWN UV channel (UV1) and scrolls INDEPENDENTLY of the base at ScrollSpeedSet2U, then
  // HARD-discards where its RED channel < threshold (fp: if t4.r - _child34.x < 0 -> discard,
  // _child34.x = 0.711). The fast-sliding mask over the (often static) base particle carves
  // the spiky flame tips that survive the cut - the sparks "shoot off / detach from the mesh
  // face." A soft luminance multiply on the BASE UV (the old take) could never slide, so it
  // only dimmed the tiled rings. ~11% of the mask survives 0.711 -> sparse spark shapes.
  vec2 chrEffMaskUv = vEffMaskUv + fract(uEffMaskTime * uEffMaskScroll);
  float chrEffMaskR = texture2D(uEffMask, chrEffMaskUv).r;
  if (chrEffMaskR < uEffMaskThreshold) discard;
#endif
  #ifdef CHR_HAS_FLOW_OVERLAY
  // Flame-wisp layer: additively composite the chr_f01 flame color over the lit skin
  // (RE: meramon fp eid 573, t5 - albedo += flame.rgb * flame.a * intensity). The
  // flame rides the same scrolling UV as the boil, further domain-warped by the flow-
  // noise (its own curl), so the wisps lick upward and churn with the body. Additive +
  // alpha-gated: it only brightens, so the atlas's dark/low-alpha regions add nothing
  // (a straight over-blend would muddy the body). Gated by the Flames toggle.
  {
    vec2 flameScrollUv = vFlowUvB + fract(uFlowTime * uFlowScrollB);
    vec2 flameUv = flameScrollUv
                 + (texture2D(uFlowNoise, vFlowUvB).xy - 0.5) * (uFlowFlameWarp * uFlowOverlayScale);
    vec4 flameCol = texture2D(uFlowFlame, flameUv);
    tex.rgb += flameCol.rgb * flameCol.a * (uFlowFlameIntensity * uFlowOverlayScale);
  }
  #endif
#else
  vec4 tex = vec4(1.0);
#endif
#ifdef CHR_HAS_BODY_OVERLAY
  // Overlay layer: combine the atlas over the base diffuse weighted by its own
  // alpha x OverlayStrength, before the alpha tint. ONE weighted operation, two
  // combines - which one is per-program and derived from the disassembly, not
  // guessed (see notes/chr-cel-overlay-model.md and
  // scripts/classify-overlay-blends.mjs).
  {
    // The UV1 layer scrolls by frac(time*ScrollSpeedSet2U) - a slow "moving light"
    // sweeping the static line stencil below (RE chronomon-robo wing). A [0,0]
    // scroll gives frac(0)=0, so non-scrolling overlays are byte-identical.
    vec4 ov = texture2D(uBodyOverlay, vOverlayUv + fract(uOverlayTime * uOverlayScroll));
    float ovW = ov.a * uOverlayStrength;
  #ifdef CHR_HAS_OVERLAY_ADD
    // e.g. tigervespamon: mad rDST, rSRC, w, rBASE - the atlas is dark markings
    // that ADD light, so it has no use for a coverage mask and is authored opaque.
    tex.rgb += ov.rgb * ovW;
  #else
    tex.rgb = mix(tex.rgb, ov.rgb, ovW);
  #endif
  }
#endif
#ifdef CHR_HAS_OVERLAY_L3
  // Layer 3, composited ON TOP of layer 2 - the engine applies them in ascending
  // layer order (chronomon-hm wings: base + ov2*w2, then lerp(that, ov3, w3)).
  // Sampled at the DIFFUSE UV, weighted by its own alpha x OverlayStrength3.
  {
    vec4 ov2 = texture2D(uOverlayL3, vChrUv);
    float ov2W = ov2.a * uOverlayL3Strength;
  #ifdef CHR_HAS_OVERLAY_L3_ADD
    tex.rgb += ov2.rgb * ov2W;
  #else
    tex.rgb = mix(tex.rgb, ov2.rgb, ov2W);
  #endif
  }
#endif
#ifdef CHR_HAS_WING_SCROLL
  // Wing scroll overlays: two additive chr604a04em layers over the base body atlas,
  // each at the mesh UV + its own time-scroll, weighted by its own alpha x strength
  // (RE draw 547: color = a02 + a04em#1.rgb*(a04em#1.a*s1) + a04em#2.rgb*(a04em#2.a*s2)).
  {
    vec2 wingBase = vChrUv * uWingTile; // tile the overlay smaller than the base atlas
    vec4 w1 = texture2D(uWingOverlay, wingBase + fract(uWingTime * uWingScroll1));
    vec4 w2 = texture2D(uWingOverlay, wingBase + fract(uWingTime * uWingScroll2));
    tex.rgb += w1.rgb * (w1.a * uWingStrength);
    tex.rgb += w2.rgb * (w2.a * uWingStrength);
  }
#endif
  vec4 base = uDiffuseAlpha * tex;
#ifdef CHR_HAS_VERTEX_COLOR
  // Per-vertex COLOR_0 modulates the flame diffuse (rgb) AND its alpha - the fb_02
  // fp multiplies the sampled diffuse by the passed-through vertex color
  // (r0.xyzw *= v0.xyzw) after the DiffuseAlpha tint, before the emissive add.
  #ifdef CHR_HAS_VERTEX_COLOR_GAMMA
  // ...but chr805's cards/body DEGAMMA the stream first - their fp runs
  // pow(v0.xyz, cb0[N].x) as log/mul/exp on the RGB, passing alpha through.
  base *= vec4(pow(vChrColor.rgb, vec3(uVertexColorGamma)), vChrColor.a);
  #else
  base *= vChrColor;
  #endif
#endif
  vec3 albedo = base.rgb;

#if defined(CHR_HAS_UNLIT_EMISSIVE) || defined(CHR_HAS_FLAT_EMISSIVE_ONLY) || defined(CHR_HAS_FLAME)
  // Unlit emissive-only cards output ONLY a constant/atlas emissive term - no albedo,
  // no lighting. Start black; the emissive add below fills it in. Skips the lit path.
  //   CHR_HAS_UNLIT_EMISSIVE - fb_03/fb_04 additive cores (cb0[10] atlas emissive).
  //   CHR_HAS_FLAT_EMISSIVE_ONLY - MachGaogamon jet vents (e_506/e_516): the fp binds
  //     a white dummy for ALPHA ONLY and never samples its RGB, so the diffuse (which
  //     the extractor bakes as a magenta missing-texture placeholder) must not leak in.
  //     The CHR_HAS_FLAT_EMISSIVE block below adds the constant EmissiveIntensity.
  //   CHR_HAS_FLAME - MachGaogamon jet flames (e_505/e_515): colour is the emissive
  //     gradient ALONE; the baseColor (uMap) is the flame SHAPE, consumed as ALPHA only
  //     (below). The CHR_HAS_EMISSIVE add fills in the gradient x EmissiveIntensity.
  vec3 color = vec3(0.0);
#elif defined(CHR_HAS_UV_DISTORT) || defined(CHR_HAS_UNLIT)
  // Fire is UNLIT. The game's fire fp is a distinct, unlit program: cb0[19].x = 0
  // zeros the SH-ambient term and cb0[2] = [1,1,1] applies no diffuse tint (RE'd
  // from apollomon_f13544.rdc, fire draw eid 587). The flame therefore passes
  // through at full brightness so its white-hot core survives to dominate the
  // additive emissive - matching the game. The body path's SH ambient + toon
  // direct + fresnel rim would dim the core well below the emissive, letting the
  // (green=0) emissive collapse the whole flame to saturated red.
  //
  // The eff cards (CHR_HAS_UNLIT) land here for the same reason, measured rather
  // than inferred. Their fp computes an SH ambient term and a fresnel-modulated
  // emissive lookup, but BOTH are switched off by their constants at every eff draw
  // in darkdramon_f3460 (514/518/522/526) and miragegaogamon-bm_f12229
  // (494/516/520):
  //   cb0[17].x = 0  -> the SH ambient product is zeroed
  //   cb0[9]    = 0  -> the emissive lookup tint is zeroed, killing that term
  //   cb0[5]    = 0  -> emissive mode 0, and its blend factor k = 0
  //   cb0[4]    = 0  -> the fresnel curve params are zeroed
  // What survives is exactly albedo + flat constant (the constant is added by the
  // CHR_HAS_FLAT_EMISSIVE block below), and cb0[1]/cb0[2] confirm the payload
  // mapping outright: cb0[1] = DiffuseAlpha, cb0[2].xyz/.w = EmissiveIntensity /
  // EmissiveSampler. So an eff card's RGB is CONSTANT across the whole quad - every
  // bit of its visible structure is alpha, composited SrcAlpha/InvSrcAlpha through
  // the ordered dither. Routed through the lit body path the cards instead picked up
  // toon direct + uFill: on Darkdramon's white-albedo wings that saturated the quad
  // and buried the root->tip alpha ramp that carries the whole wing shape, and on
  // MirageGaogamon BM's BLACK-albedo ef_* (DiffuseColor [0,0,0,0.3]) it left uFill
  // as the only non-emissive term, washing the saturated yellow-green constant
  // toward cream.
  vec3 color = albedo;
#else
  vec3 N = normalize(vWorldNormal);
#ifdef CHR_HAS_NORMAL_MAP
  // Normal map: perturb N in world space via the authored TBN. (see README: Normal mapping)
  {
    vec3 mapN = texture2D(uNormalMap, vChrUv).xyz * 2.0 - 1.0;
    mapN.xy *= uNormalScale;
    ${NORMAL_MAP_FLIP_GREEN ? 'mapN.y = -mapN.y;' : ''}
    vec3 T = normalize(vWorldTangent - dot(vWorldTangent, N) * N);
    vec3 B = cross(N, T) * (vTangentW * ${f(TANGENT_W_SIGN)});
    N = normalize(mat3(T, B, N) * mapN);
  }
#endif
  vec3 V = normalize(vViewDirW);
  float ndotv = max(dot(N, V), 0.0);

  // Body lighting: SH ambient + toon-ramp direct + fresnel rim, self-shadowed by
  // getShadowMask() (1.0 when shadows off). (see README: Direct lighting)
  float SHADOW_FACTOR = getShadowMask();
  vec3 ambient = max(evalSH9(uSH, N), vec3(0.0)) * albedo * uShScale * INV_PI;
  // Direct light accumulation (albedo applied to the diffuse term only). The rim
  // takes the scene light COLOR (rimTint), NOT this ndotl-gated sum. (see README:
  // Direct lighting)
  vec3 lightAccum = vec3(0.0);
  vec3 rimTint = vec3(0.0);
  // The key ramp's shadow end - the sample the engine lerps toward under shadow.
  // Loop-invariant, so hoisted. (see README: Self-shadow)
  vec3 keyShadowBand = toonBandAtU(${f(RAMP_SHADOW_U)}, 0);
  for (int i = 0; i < ${MAX_RIG_LIGHTS}; i++) {
    if (i >= uNumLights) break;
    float ndotl = dot(N, normalize(uLightDirs[i]));
    // Ramp per light: key (0) neutral, fill (>=1) cool. (see README: Toon ramp)
    vec3 band = toonBand(ndotl, i);
    // Self-shadow slides the ramp lookup toward its shadow end - it does NOT
    // scale the light. The engine gates this per light on a shadow-cast flag
    // (cb0[light*6+2].w > 0.5); our rig's analog is the KEY light, so fills
    // stay unshadowed and keep their cool bounce in shadow, like the game.
    if (i == 0) band = mix(keyShadowBand, band, SHADOW_FACTOR);
    lightAccum += uLightColors[i] * band;
    // The ubershader tints the rim by the toon RAMP color (r7), not the diffuse
    // sum; approximate it with the ungated per-light color so the rim stays lit at
    // the silhouette (where ndotl -> 0, but a sphere's fresnel peaks).
    rimTint += uLightColors[i];
  }
  vec3 direct = albedo * lightAccum;
  // Fresnel rim x color x spec-atlas alpha mask x scene-light tint, ON by default
  // (uGlowRimScale = 1, editor toggle). (see README: Rim glow) The game adds this
  // additively at the silhouette, unmodulated by ndotl - tinting by rimTint (not
  // lightAccum) keeps it from vanishing at the edge where a sphere's fresnel peaks.
  float gA = innerGrowA(ndotv, uInnerGrowABase);
#ifdef CHR_HAS_SPEC_MASK
  float rimMask = texture2D(uSpecMap, vChrUv).w;
#else
  float rimMask = 1.0;
#endif
  vec3 rim = uGlowRimScale * gA * uInnerGrowAColor * rimMask * rimTint;
  vec3 color = ambient + (direct + rim) * ${f(DIRECT_EXPOSURE)} + uFill;
  // Global shadow attenuation. The engine scales the whole light composite -
  // SH ambient included - by lerp(SHADOW_FLOOR, 1, shadow), so shadows bottom
  // out near half instead of at black. Applied before env reflect / emissive,
  // which are added after this point and are not shadow-attenuated.
  color *= mix(${f(SHADOW_FLOOR)}, 1.0, SHADOW_FACTOR);
#ifdef CHR_HAS_PHANTOM_GROW
  // $PhantomGrowTexture - the "rolling white" that fades in shortly after a model
  // loads (notes/chr-cel-overlay-model.md 6d, RenderDoc-confirmed on
  // chronomon-hm/dm). The engine picks one of three projections on cb0[1049].x;
  // the captured state selects the TRIPLANAR branch, projecting in WORLD space and
  // weighting the three planar samples by the squared normal. That world-space
  // projection is why it reads as a texture sitting UNDER the model, rolling
  // through it, rather than a decal sliding across its UVs.
  //
  // Added over the LIT COLOUR, not blended into the albedo - so the overlay
  // layers cannot mask it, and it reads as a separate wash lying under the paint.
  // Position matches the asm: the engine composites the grow at 802-811 and only
  // then runs the Bayer discard at 820-833, so a dithered-away pixel loses the
  // grow with everything else. The "peeking through the cracks" look comes from
  // the OVERLAY pattern being weak in those texels, not from surviving the dither.
  {
    vec3 gN = normalize(vWorldNormal);
    vec3 gW = gN * gN;                       // squared normal = the triplanar weights
    gW /= max(gW.x + gW.y + gW.z, 1e-4);
    vec2 guv = vGrowUv(vWorldPos.zy);        // x-plane
    vec3 g = texture2D(uGrowMap, guv).rgb * gW.x;
    g += texture2D(uGrowMap, vGrowUv(vWorldPos.xz)).rgb * gW.y;
    g += texture2D(uGrowMap, vGrowUv(vWorldPos.xy)).rgb * gW.z;
    color += g * uGrowTint * uGrowStrength;
  }
#endif
#ifdef CHR_HAS_ENV_REFLECT
  // Environment reflection composited pre-fog (see README: Environment
  // reflection); steered off the geometric normal - see the reflect() note below.
  // The metallic mask
  // (a01m green -> metalnessMap.b) scales the reflection layer; that layer is
  // HARD-LIGHT blended over the lit color and mixed back by the mask, so metals
  // keep their hue and gain metallic contrast (a straight replace grayed them).
  // Faithful to the body shader's reflect -> cube -> hard-light -> mask block.
  vec3 litColor = color;
  // Reflect off the GEOMETRIC surface normal, not the normal-map-perturbed N.
  // The env cube is only 128px/face and steeply lit (bright +Y, near-black sides),
  // so steering R with the 1024px normal map makes it jitter across that bright/
  // dark boundary faster than the cube can resolve - a clean reflected band reads
  // back as scrambled speckle (specular aliasing the game hides under bloom +
  // tonemap, which the viewer lacks). The geometric normal sweeps the cube
  // smoothly, so the reflection is coherent. Normal-map detail still drives the
  // lit/toon shading above; only the mirror term uses the smooth normal. When a
  // material has no normal map, N already equals vWorldNormal - no change there.
  vec3 R = reflect(-normalize(vViewDirW), normalize(vWorldNormal)); // world-space
  float metallic = texture2D(uReflectMask, vChrUv).b;
  vec3 reflLayer = textureCube(uEnvCube, R).rgb * metallic * uReflectIntensity;
  vec3 blended = chrHardLight(litColor, reflLayer);
  // color = strength*hardLight + lit*(1 - metallic*strength); metallic 0 -> lit.
  color = uReflectStrength * blended + litColor * (1.0 - metallic * uReflectStrength);
#endif
#endif // CHR_HAS_UV_DISTORT else (fire took the unlit path above)

  // Bayer screen-door alpha test; skipped for smooth-blend surfaces
  // (visor/wing/glass). (see README: Dithered transparency)
  float alpha = base.a;
#ifdef CHR_HAS_FLAME
  // Jet-flame alpha = mask.a x DiffuseAlpha.w (already in base.a) x reverse-fresnel.
  // The fp modulates the mask alpha by a view-dependent term that is opaque head-on
  // and fades at grazing angles (fs.105a6b5e r2 block); compute N,V here since the
  // unlit colour branch skipped them. This alpha then feeds the CHR_HAS_DITHER_BLEND
  // screen door below (the flame is a dithered SrcAlpha blend, not a hard cutout).
  {
    vec3 Nf = normalize(vWorldNormal);
    vec3 Vf = normalize(vViewDirW);
    float ndotvF = max(dot(Nf, Vf), 0.0);
    alpha *= flameFresnel(ndotvF, uFlameFresnelSub, uFlameFresnelRange, 0.0);
  }
#endif
#ifdef CHR_HAS_ALPHA_TEST
  // Ungated alpha test. The game program hard-discards below a threshold BEFORE it
  // reaches the screen door (asm: mul rN.w, r2.w, r0.w / lt rN.w, cb0[0].x /
  // discard_nz, all at top level, outside the cover/dissolve branch). Snapshotted per
  // shader_hash from the disassembly (data/alpha_test_shader_hashes.json) - the same
  // static-property approach as the dither set, and for the same reason: the presence of
  // a CoverSampler uniform says nothing about what the program does.
  //
  // Tests 'alpha' - the diffuse alpha already folded with DiffuseAlpha.w and the vertex
  // colour - rather than reconstructing the asm's two-register product. That is exactly
  // the quantity the Bayer door below tests, on a path confirmed correct, so the two
  // cutoffs agree on what "coverage" means. If a mesh ever vanishes wholesale under this,
  // the second sampler genuinely participates and the fix belongs here, with evidence.
  if (alpha < uAlphaTest) discard;
#endif

#ifdef CHR_HAS_UV_DISTORT
  // Fire composite Layers B/A: shape = flame.a x emissive.a x DiffuseAlpha.w (the
  // RE'd fire alpha, notes/fire-effects.md). uFireBlend picks the layer: 0 = opaque
  // core (B), the ordered-dither screen-door discard below; 1 = soft body (A),
  // per-pixel alpha-blend.
  float fireEmA = 1.0;
  #ifdef CHR_HAS_EMISSIVE
  fireEmA = texture2D(uEmissiveMap, vEmUv).a;
  #endif
  float fireAlpha = alpha * fireEmA;
  // The eff fp masks the flame by its OWN alpha through the SAME 4x4 ordered-dither
  // screen-door the cover-fray uses (asm 145-161: discard if flame.a*em.a <
  // bayer[screen]) - NOT a hard cutoff. chr_f02's transparent edges stipple out to
  // nothing, so the warped/scrolling flame stays contained to where the atlas has
  // opaque flame pixels instead of a hard binary contour that clips at the mesh edge.
  if (uFireBlend < 0.5) {
    const float bayer[16] = float[16](${bayerGLSL()});
    // Screen-door index = pixel coord mod 4 on BOTH axes. The game gets there the
    // long way - screenUV * ScreenSize, then x0.25 -> frac -> x4 -> ftoi - which is
    // an exact mod-4 extraction, not a scale; gl_FragCoord.xy already IS the pixel
    // coord. There is NO dither-scale uniform in the asm (chr ubershader and eff
    // card both multiply only by ScreenSize).
    int ix = int(mod(gl_FragCoord.x, 4.0));
    int iy = int(mod(gl_FragCoord.y, 4.0));
    if (fireAlpha < bayer[ix * 4 + iy]) discard;
  }
#elif defined(CHR_HAS_UNLIT_EMISSIVE)
  // Additive core: the game program runs NO alpha-test (its cover/dither branch is
  // inactive - no CoverSampler). The emissive card's alpha rides out as the
  // SrcAlpha additive gate (set in the emissive block below), so nothing discards.
#else
  // Screen door, scoped by whether the mesh's PROGRAM actually implements the Bayer
  // dither (uProgramDithers, from data/dither_shader_hashes.json - see chrCel.ts).
  // This used to be scoped by the CoverSampler uniform, which is wrong in both
  // directions: CoverSampler is the cover/dissolve discard THRESHOLD, so a material
  // can carry it with no dither in its program (skullseadramon's translucent fin)
  // and can dither with no CoverSampler at all (slayerdramon's eff_swe card, whose
  // transparency the cover-scoped gate silently switched off). A plain translucent
  // surface (glass dome / visor) whose diffuse alpha is a packed spec channel still
  // does not stipple - its program has no dither either.
  bool ditherOn = uAlphaBlend < 0.5 && uProgramDithers > 0.5;
#ifdef CHR_HAS_DITHER_BLEND
  // The eff cards run the dither AND blend the survivors, so their gate is not the
  // usual "cover surfaces only" one. (see README: Dither)
  ditherOn = true;
#endif
  if (ditherOn) {
    const float bayer[16] = float[16](${bayerGLSL()});
    // Screen-door index = pixel coord mod 4 on BOTH axes. The game gets there the
    // long way - screenUV * ScreenSize, then x0.25 -> frac -> x4 -> ftoi - which is
    // an exact mod-4 extraction, not a scale; gl_FragCoord.xy already IS the pixel
    // coord. There is NO dither-scale uniform in the asm (chr ubershader and eff
    // card both multiply only by ScreenSize).
    int ix = int(mod(gl_FragCoord.x, 4.0));
    int iy = int(mod(gl_FragCoord.y, 4.0));
    if (alpha < bayer[ix * 4 + iy]) discard;
  }
#endif

#ifdef CHR_HAS_EMISSIVE
  // Emissive add, post-lighting / pre-fog, on the em atlas's own UV. (see README: Emissive)
  vec2 emSampleUv = vEmUv;
  #ifdef CHR_HAS_FLOW_OVERLAY
  emSampleUv += chrFlowWarp; // ride the boil warp so the glow churns with the flesh
  #endif
  #ifdef CHR_HAS_UNLIT_EMISSIVE
  // Additive core (fb_03/fb_04): the game program outputs the core texture at FULL
  // brightness. RenderDoc apollomon_frame8704 eid 947: the emissive multiplier
  // cb0[1] = [1,1,1,1] and the fade cb0[9].w = 0, so color = t1.rgb x 1. It does
  // NOT apply the body fire shader's EmissiveIntensity/EmissiveSampler pair - that
  // is cb0[2], a cover-branch constant this program's active (else) path never
  // reads. Applying it (the earlier port) darkened the core to ~42% and it washed
  // out under the additive flame layers. Out-alpha = t1.a^2 (o0.w = t1.a * t1.a *
  // scale, saturated); this core atlas is fully opaque, so the additive gate is ~1.
  vec4 emCard = texture2D(uEmissiveMap, emSampleUv);
  color += emCard.rgb;
  alpha = emCard.a * emCard.a;
  #else
  color += texture2D(uEmissiveMap, emSampleUv).rgb * uEmissive * uEmissiveStrength;
  #endif
#endif
#if defined(CHR_HAS_FLAT_EMISSIVE) || defined(CHR_HAS_FLAT_EMISSIVE_ONLY)
  // eff-card program: a FLAT CONSTANT emissive add with no atlas at all - the fp's
  // mad of EmissiveColor.rgb x EmissiveIntensity straight onto the shaded color
  // (RDEF: fp $Params reg2.xyz + reg2.w). The ubershader emissive above modulates an
  // em atlas, so it gates on an emissiveMap the eff cards never bind - which dropped
  // their glow entirely. Where the card's DiffuseColor is black (MirageGaogamon BM's
  // ef_* meshes) this term is the mesh's ONLY color. (see README: Emissive)
  color += uEmissive * uEmissiveStrength;
#endif
  // Fog. (see README: Fog)
  color = mix(color, uFogColor, clamp(uFogAmount, 0.0, 1.0));

#ifdef CHR_HAS_EFF_SCREEN_DOOR
  // Gallantmon (X) sword energy (center_pt / aura_b02): the game paints these as a BINARY
  // Bayer screen-door STIPPLE of the coverage, not a smooth alpha blend (captured aura fp
  // eid 558: out.a = coverage >= bayer[screen] ? 1 : 0, with the stipple<->smooth lerp
  // _child34.y = 0 -> a PURE stipple). Coverage = particle alpha (base.a, already carrying
  // the vertex + DiffuseAlpha.w factors) x emissive alpha - the emissive.a*base.a*vcol.a
  // product the fp dithers. Survivors output FULL weight so the SrcAlpha blend writes them
  // opaque and bloom fills the grain into a glow the way the game's tonemap does. This is
  // the same 4x4 ordered dither the cover-fray / eff-card paths use (an exact pixel-mod-4
  // extraction; no dither-scale uniform). See project_gallantmon_x_hilt_effect_re pt7.
  {
    float effCoverage = alpha;
    #ifdef CHR_HAS_EMISSIVE
    effCoverage *= texture2D(uEmissiveMap, vEmUv).a;
    #endif
    const float effBayer[16] = float[16](${bayerGLSL()});
    int effIx = int(mod(gl_FragCoord.x, 4.0));
    int effIy = int(mod(gl_FragCoord.y, 4.0));
    if (effCoverage < effBayer[effIx * 4 + effIy]) discard;
    alpha = 1.0; // binary survivor (game _child34.y = 0 -> full weight, not fractional)
  }
#endif

  // Output alpha: opaque, or the per-pixel diffuse alpha on blend surfaces
  // (visor/wing/glass); fire uses its composite alpha (opaque core vs soft body).
  float outAlpha = mix(1.0, alpha, uAlphaBlend);
#ifdef CHR_HAS_UV_DISTORT
  // Opaque fire core (uFireBlend 0, e.g. fb_01) outputs alpha 1. The soft body
  // layer (uFireBlend 1) AND any alpha_mode:BLEND fire mesh (uAlphaBlend 1, e.g.
  // fb_02 - RenderDoc eid 538 draws SrcAlpha,InvSrcAlpha) output the real fire
  // alpha, so the flame reads translucent instead of a solid card.
  outAlpha = (uFireBlend < 0.5 && uAlphaBlend < 0.5) ? 1.0 : fireAlpha;
#endif
#ifdef CHR_HAS_UNLIT_EMISSIVE
  outAlpha = alpha; // the squared emissive-card cutout - the additive SrcAlpha gate
#endif
  // (Gallantmon X eff mask is a HARD discard above - no output-alpha modulation here.)
  gl_FragColor = vec4(max(color, vec3(0.0)), outAlpha);
}
`;
}

/** Stable cache key for three's program cache, keyed on the full permutation
 *  tuple so distinct variants don't collide (asm has no runtime branches we
 *  vary, but skinning/map/channel/feature flags change the compiled source). */
export function chrCelCacheKey(d: ChrCelDefines): string {
  return `chrcel:${d.skinning ? 'S' : '_'}${d.hasMap ? 'M' : '_'}${d.mapChannel}${
    d.hasEnvReflect ? 'R' : '_'
  }${d.hasNormalMap ? 'N' : '_'}${d.hasSpecMask ? 'P' : '_'}${d.hasEmissive ? 'E' : '_'}${
    d.emMapChannel
  }${d.hasBodyOverlay ? (d.overlayAdd ? 'A' : 'O') : '_'}${
    d.hasOverlayL3 ? (d.overlayL3Add ? 'c' : 'C') : '_'
  }${d.hasPhantomGrow ? 'g' : '_'}${d.hasFlowOverlay ? 'W' : '_'}${d.hasUvDistort ? 'F' : '_'}${
    d.hasVertexColor ? (d.hasVertexColorGamma ? 'G' : 'V') : '_'
  }${d.hasUnlitEmissive ? 'Y' : '_'}${d.hasBillboard ? 'B' : '_'}${
    d.hasFlatEmissive ? 'L' : '_'
  }${d.hasDitherBlend ? 'D' : '_'}${d.hasUnlit ? 'U' : '_'}${d.hasFlatEmissiveOnly ? 'X' : '_'}${
    d.hasFlame ? 'J' : '_'
  }${d.hasGalaxyStars ? 'G' : '_'}${d.hasWingScroll ? 'K' : '_'}${
    d.hasEffScroll ? 'E' : '_'
  }${d.hasEffMask ? 'M' : '_'}${d.hasEffScreenDoor ? 'S' : '_'}${d.hasAlphaTest ? 'A' : '_'}`;
}

/** three `ShaderMaterial.defines` for a chr-cel permutation. The GLSL is a single
 *  static superset now; these defines specialize it. The `CHR_HAS_*` flags guard
 *  the feature `#ifdef`s; `CHR_MAP_UV`/`CHR_EM_UV` are value defines feeding the
 *  vertex UV ladders; `USE_*` are three's own (skinning / tangent / uv-set attrs).
 *
 *  three declares the `uv1`/`uv2` attributes only under `USE_UV1`/`USE_UV2` (`uv`
 *  is always present), so each routed channel sets the matching attribute define.
 *  The diffuse UV is selected by its OWN channel (`CHR_MAP_UV`), not "highest
 *  available" - the emissive's `USE_UVx` must not hijack it (eye-emissive declares
 *  uv1 for its UV2 em while the diffuse stays on uv0). */
export function chrCelMatDefines(d: ChrCelDefines): Record<string, string> {
  const def: Record<string, string> = {};
  if (d.skinning) def.USE_SKINNING = '';
  if (d.hasMap) def.CHR_HAS_MAP = '';
  if (d.hasEnvReflect) def.CHR_HAS_ENV_REFLECT = '';
  if (d.hasNormalMap) def.CHR_HAS_NORMAL_MAP = '';
  if (d.hasSpecMask) def.CHR_HAS_SPEC_MASK = '';
  if (d.hasEmissive) def.CHR_HAS_EMISSIVE = '';
  if (d.hasBodyOverlay) def.CHR_HAS_BODY_OVERLAY = '';
  if (d.hasBodyOverlay && d.overlayAdd) def.CHR_HAS_OVERLAY_ADD = '';
  if (d.hasOverlayL3) def.CHR_HAS_OVERLAY_L3 = '';
  if (d.hasOverlayL3 && d.overlayL3Add) def.CHR_HAS_OVERLAY_L3_ADD = '';
  if (d.hasPhantomGrow) def.CHR_HAS_PHANTOM_GROW = '';
  // Diffuse UV: channel value define + the matching USE_UVx attribute declaration.
  if (d.hasMap) def.CHR_MAP_UV = String(d.mapChannel);
  if (d.mapChannel === 1) def.USE_UV1 = '';
  if (d.mapChannel === 2) def.USE_UV2 = '';
  // Emissive UV is routed by its own channel (union the uv-set attribute with the
  // diffuse's). Eye-emissive meshes are diffuse-less, so forcing USE_UV1 here
  // never perturbs the diffuse routing (which only runs under CHR_HAS_MAP).
  if (d.hasEmissive) {
    def.CHR_EM_UV = String(d.emMapChannel);
    if (d.emMapChannel === 1) def.USE_UV1 = '';
    if (d.emMapChannel === 2) def.USE_UV2 = '';
  }
  // USE_TANGENT -> three declares `attribute vec4 tangent;` + skins objectTangent.
  if (d.hasNormalMap) def.USE_TANGENT = '';
  // Body decal rides TEXCOORD_1 -> declare uv1.
  if (d.hasBodyOverlay) def.USE_UV1 = '';
  // Flaming-skin body: the flow-noise + flame wisps ride TEXCOORD_1 -> declare uv1.
  if (d.hasFlowOverlay) {
    def.CHR_HAS_FLOW_OVERLAY = '';
    def.USE_UV1 = '';
  }
  // Fire flame-boil distortion: the flow-noise scrolls on TEXCOORD_1 -> declare uv1.
  if (d.hasUvDistort) {
    def.CHR_HAS_UV_DISTORT = '';
    def.USE_UV1 = '';
  }
  // Per-vertex COLOR_0 flame modulation (fb_02): emit USE_COLOR_ALPHA so three
  // declares `attribute vec4 color;` (same mechanism as USE_UV1 declaring uv1).
  if (d.hasVertexColor) {
    def.CHR_HAS_VERTEX_COLOR = '';
    def.USE_COLOR_ALPHA = '';
    // Separate flag so the raw-multiply meshes (fb_02) keep byte-identical math.
    if (d.hasVertexColorGamma) def.CHR_HAS_VERTEX_COLOR_GAMMA = '';
  }
  // Unlit emissive-only additive core (fb_03/fb_04).
  if (d.hasUnlitEmissive) def.CHR_HAS_UNLIT_EMISSIVE = '';
  if (d.hasFlatEmissive) def.CHR_HAS_FLAT_EMISSIVE = '';
  if (d.hasFlatEmissiveOnly) def.CHR_HAS_FLAT_EMISSIVE_ONLY = '';
  if (d.hasDitherBlend) def.CHR_HAS_DITHER_BLEND = '';
  if (d.hasUnlit) def.CHR_HAS_UNLIT = '';
  if (d.hasFlame) def.CHR_HAS_FLAME = '';
  // Galaxy portal: screen-space star UV override (needs no extra attribute - it
  // reads gl_Position in the vertex shader).
  if (d.hasGalaxyStars) def.CHR_HAS_GALAXY_STARS = '';
  // Wing scroll: two additive chr604a04em overlays on the base diffuse UV (no extra
  // attribute - they ride the diffuse's TEXCOORD_0 vChrUv).
  if (d.hasWingScroll) def.CHR_HAS_WING_SCROLL = '';
  // Sword-energy particle scroll (Gallantmon X): offsets the base diffuse UV in-shader
  // (rides the diffuse's TEXCOORD_0 vChrUv - no extra attribute).
  if (d.hasEffScroll) def.CHR_HAS_EFF_SCROLL = '';
  // Sword-energy dissolve mask (Gallantmon X): samples the ScratchBorder mask on UV1
  // (TEXCOORD_1) scrolled independently at Set2U, and HARD-discards below the threshold.
  // Rides UV1 -> declare the uv1 attribute (same mechanism as the flow/overlay features).
  if (d.hasEffMask) {
    def.CHR_HAS_EFF_MASK = '';
    def.USE_UV1 = '';
  }
  // Sword-energy screen-door (Gallantmon X): stipples the output alpha through the 4x4
  // Bayer/17 ordered dither instead of smooth-blending (center_pt / aura_b02).
  if (d.hasEffScreenDoor) def.CHR_HAS_EFF_SCREEN_DOOR = '';
  if (d.hasAlphaTest) def.CHR_HAS_ALPHA_TEST = '';
  // Camera-facing billboard (fb_02) - needs the skin matrix for the bone transform.
  if (d.hasBillboard) {
    def.CHR_HAS_BILLBOARD = '';
    def.USE_SKINNING = '';
  }
  return def;
}

/** Vertex attribute preamble for the STANDALONE superset export. At runtime three
 *  injects these under USE_UVx / USE_TANGENT, so the guarded source must NOT
 *  declare them itself (double declaration). An external consumer has no three
 *  prefix, so
 *  the export prepends this fixed glTF-semantic set (POSITION / NORMAL / TEXCOORD_0
 *  -2 / TANGENT). It's a closed spec constant - new feature splits reuse these
 *  attributes, so it never drifts. A declared-but-unbound attribute reads its
 *  default, so declaring the full set is always safe. */
export const CHR_CEL_ATTRIBUTES = [
  'attribute vec3 position;',
  'attribute vec3 normal;',
  'attribute vec2 uv;',
  'attribute vec2 uv1;',
  'attribute vec2 uv2;',
  'attribute vec4 tangent;',
  'attribute vec4 color;',
].join('\n');

/** The chr-cel ubershader as a single standalone export artifact: the attribute
 *  preamble + the un-preprocessed `#ifdef` superset (every feature branch present,
 *  guarded). The per-model define set comes from `chrCelMatDefines`; the full flag
 *  vocabulary is `CHR_CEL_FEATURE_DEFINES`. NOTE: the source still carries three's
 *  `#include <...>` chunk markers (skinning / shadow); resolving or stubbing those
 *  for a non-three engine is the export feature's job (skinning is reference-only
 *  for a porter - see notes/shader-export-feature.md). */
export function buildChrCelSuperset(): { attributes: string; vertex: string; fragment: string } {
  return {
    attributes: CHR_CEL_ATTRIBUTES,
    vertex: buildChrCelVertex(),
    fragment: buildChrCelFragment(),
  };
}

/** Every feature flag the superset's `#ifdef`s gate (NOT the USE_* / value
 *  defines, which three owns or `chrCelMatDefines` derives). The drift-guard pins
 *  to the actual `CHR_HAS_*` guards in the source + the keys `chrCelMatDefines`
 *  emits, so a new split can't be added without wiring all three. */
export const CHR_CEL_FEATURE_DEFINES = [
  'CHR_HAS_MAP',
  'CHR_HAS_ENV_REFLECT',
  'CHR_HAS_NORMAL_MAP',
  'CHR_HAS_SPEC_MASK',
  'CHR_HAS_EMISSIVE',
  'CHR_HAS_BODY_OVERLAY',
  'CHR_HAS_OVERLAY_ADD',
  'CHR_HAS_OVERLAY_L3',
  'CHR_HAS_OVERLAY_L3_ADD',
  'CHR_HAS_PHANTOM_GROW',
  'CHR_HAS_FLOW_OVERLAY',
  'CHR_HAS_UV_DISTORT',
  'CHR_HAS_VERTEX_COLOR',
  'CHR_HAS_VERTEX_COLOR_GAMMA',
  'CHR_HAS_UNLIT_EMISSIVE',
  'CHR_HAS_BILLBOARD',
  'CHR_HAS_FLAT_EMISSIVE',
  'CHR_HAS_FLAT_EMISSIVE_ONLY',
  'CHR_HAS_DITHER_BLEND',
  'CHR_HAS_ALPHA_TEST',
  'CHR_HAS_UNLIT',
  'CHR_HAS_FLAME',
  'CHR_HAS_GALAXY_STARS',
  'CHR_HAS_WING_SCROLL',
  'CHR_HAS_EFF_SCROLL',
  'CHR_HAS_EFF_MASK',
  'CHR_HAS_EFF_SCREEN_DOOR',
] as const;
