// GLSL for the additive eye-shine pass (EyeShineEffect).
//
// The separate eye_L/eye_R (eye_C / eye_*01 ...) hemisphere meshes carry the
// matcap `InnerGrowAValue` slot (`<chr>e01h`) and NO iris diffuse - the
// iris/sclera is painted on the face beneath them. This pass only ADDS the wet
// specular highlight from the e01h glint atlas, composited additively so the
// atlas' black background contributes nothing and only the highlights add.
//
// Ground truth (RenderDoc, dorugamon_f42437 eye draws 601/605 + the 0x726d5a22
// vp/fp asm): the shine is a VIEW-RELATIVE Blinn SPHERE-MAP matcap, NOT an
// authored-UV sample. The fp (L488-501) reflects the camera->surface ray about
// the (view-space) normal and projects it to a sphere-map UV:
//     r  = reflect(-viewDir, N)
//     uv = r.xy / (2*sqrt(r.x^2 + r.y^2 + (r.z+1)^2)) + 0.5
//     sample e01h at uv
// Because the reflection is view-relative, the glint SLIDES across the eye as the
// camera orbits - that view-dependence is what brings the eyes to life. The
// e01h atlas encodes the glints in its ALPHA (RGB is flat white), so the viewer's
// MatcapComposer pre-swizzles alpha->RGB and we sample `.rgb` here.
//
// The game additionally rotates N + view-dir by a per-character `cb0[7]` tilt
// before the reflect (small art-directed angles; some chrs zero). That tilt is a
// PLACEHOLDER identity (no rotation) here - to be refined once the roster survey
// of cb0[7] lands.

export interface EyeShineDefines {
  /** Claimed mesh is a SkinnedMesh -> activate the three skinning chunks. */
  skinning: boolean;
  /** The e01h matcap (shine) atlas is bound as `uMatcap`. */
  hasMatcap: boolean;
  /** A b01m expression mask is bound (`uEyeMask`) - crops the shine to the
   *  per-expression iris outline (sampled at the authored UV). */
  hasEyeMask: boolean;
  /** The eye mesh carries a per-vertex COLOR_0 - its alpha is folded in as an
   *  extra crop. KNOWN DIVERGENCE from the engine (see the fragment note). */
  hasEyeColor: boolean;
}

/** Cache key so three reuses one compiled program per define permutation. */
export function eyeShineCacheKey(d: EyeShineDefines): string {
  return `eyeshine|${d.skinning ? 's' : ''}|${d.hasMatcap ? 'm' : ''}|${d.hasEyeMask ? 'k' : ''}|${
    d.hasEyeColor ? 'c' : ''
  }`;
}

/** three `ShaderMaterial.defines` for an eye-shine permutation. Keys match the
 *  `#ifdef` guards in the GLSL below; `''` = defined (three emits `#define NAME`),
 *  absent = undefined. Skinning rides three's own `USE_SKINNING`. The GLSL source
 *  is now a single static superset specialized entirely by these defines. */
export function eyeShineMatDefines(d: EyeShineDefines): Record<string, string> {
  const def: Record<string, string> = {};
  if (d.skinning) def.USE_SKINNING = '';
  if (d.hasMatcap) def.CHR_EYE_MATCAP = '';
  if (d.hasEyeMask) def.CHR_EYE_MASK = '';
  if (d.hasEyeColor) def.CHR_EYE_COLOR = '';
  return def;
}

export function buildEyeShineVertex(): string {
  return `
#include <common>
#include <skinning_pars_vertex>
varying vec2 vEyeUv;
varying vec3 vViewNormal;
varying vec3 vViewPos;
#ifdef CHR_EYE_COLOR
attribute vec4 color;
varying float vEyeColorA;
#endif
void main() {
  vEyeUv = uv; // authored TEXCOORD_0 - only the b01m expression mask samples it
#ifdef CHR_EYE_COLOR
  vEyeColorA = color.a;
#endif
  vec3 objectNormal = normalize(normal);
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  vec3 transformed = position;
  #include <skinning_vertex>
  vViewNormal = normalize(normalMatrix * objectNormal);
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  vViewPos = -mvPosition.xyz; // surface -> camera (three matcap convention)
  gl_Position = projectionMatrix * mvPosition;
}
`;
}

export function buildEyeShineFragment(): string {
  return `
varying vec2 vEyeUv;
varying vec3 vViewNormal;
varying vec3 vViewPos;
uniform vec2 uMatcapTilt; // per-eye cb0[7].xy art-tilt (0 = none; see note below)
#ifdef CHR_EYE_MATCAP
uniform sampler2D uMatcap;
#endif
#ifdef CHR_EYE_MASK
uniform sampler2D uEyeMask;
uniform vec2 uEyeMaskOffset;
#endif
#ifdef CHR_EYE_COLOR
varying float vEyeColorA;
#endif
void main() {
  // View-relative Blinn sphere-map matcap (0x726d5a22 fp L488-501).
  vec3 N = normalize(vViewNormal);
  vec3 viewDir = normalize(vViewPos);          // surface -> camera
  vec3 r = reflect(-viewDir, N);               // reflect the camera->surface ray
  // Per-eye matcap tilt - the game rotates N/view by cb0[7].xy before the reflect
  // (vp 0x726d5a22: rotate around Y by .y, then X by .x). Equivalent to rotating
  // the reflection vector, done here. Identity when uMatcapTilt is 0 (the shipped
  // default). NOTE: this is a VIEW-SPACE approximation of the game's object-space
  // rotation - representative, not pixel-exact; the real per-eye values are to be
  // baked per-model (see ../dsts-extractor/requests/eye-shine-matcap-rotation.md).
  {
    float sy = sin(uMatcapTilt.y), cy = cos(uMatcapTilt.y);
    float sx = sin(uMatcapTilt.x), cx = cos(uMatcapTilt.x);
    float rx = r.x * cy - r.z * sy;
    float tz = r.x * sy + r.z * cy;
    r = vec3(rx, r.y * cx + tz * sx, -r.y * sx + tz * cx);
  }
  float m = 2.0 * sqrt(r.x * r.x + r.y * r.y + (r.z + 1.0) * (r.z + 1.0));
  vec2 mUv = r.xy / m + 0.5;
#ifdef CHR_EYE_MATCAP
  vec4 shine = texture2D(uMatcap, mUv);
#else
  vec4 shine = vec4(0.0);
#endif
  // Crop weight scaling the additive contribution (output alpha; AdditiveBlending
  // = srcAlpha*src + dst). The localizing crop is the b01m mask below.
  // Vidar correction: chr701e01h stores the highlight in alpha; its RGB is
  // almost entirely white, including fully transparent texels. Preserve that
  // coverage for SrcAlpha additive blending instead of whitening the iris.
  float eyeCrop = shine.a;
#ifdef CHR_EYE_MASK
  // PRIMARY crop - the b01m expression mask (the eye mesh's OverlayMaskSampler),
  // sampled at the AUTHORED UV (vEyeUv) with the expression-row offset. Green
  // channel carries the open-eye outline; closed rows are zero, so the shine
  // vanishes on closed eyes. This is the engine's actual clip (RenderDoc-confirmed:
  // the eye fp samples b01m.green at the authored UV - guilmon t4 == chr090b01m).
  eyeCrop *= texture2D(uEyeMask, vEyeUv + uEyeMaskOffset).g;
#endif
#ifdef CHR_EYE_COLOR
  // KNOWN DIVERGENCE from the engine. The engine does NOT crop the shine by
  // COLOR_0 - it scales b01m.green by a per-material gain cb0[1198].x (=3.22 on
  // guilmon) and saturates, which is what tightens a loose/feathered b01m to the
  // iris. That fragment gain is not surfaced in the GLB's current eye uniforms and
  // its authored source isn't yet traced (cf. the eye-shine matcap request, where
  // the vertex cb0[7] tilt turned out to be canonical after all under a misleading
  // slot name - cb0[1198] may resolve the same way, or be a global/derived value).
  // Until it's resolved we fold in the eye mesh's per-vertex COLOR_0.a as a
  // stand-in: an authored, per-model hemisphere falloff that approximates the same
  // tightening - without it, chrs whose b01m.green is loose (terriermon) bleed past
  // the iris and those whose green is undersized (gabumon) need it least. Remove
  // once cb0[1198].x is resolved. See ../dsts-extractor (eye-shine matcap request).
  eyeCrop *= vEyeColorA;
#endif
  gl_FragColor = vec4(max(shine.rgb, vec3(0.0)), eyeCrop);
}
`;
}
