// Pure-TS 1:1 transcriptions of the chr cel/eye fragment shader's scalar
// sub-functions, lifted straight from the DXBC disasm (/tmp/guil_fp.asm ==
// doru_fp.asm). This module is the SINGLE SOURCE OF TRUTH for the magic
// constants (acos polynomial, SH band weights, toon-ramp remap, Bayer matrix):
// `chrCel.glsl.ts` injects the same numbers into the shader as `const`/`#define`,
// and `chrCel.math.test.ts` asserts each function against values hand-computed
// from the asm + the captured cb0. Keeping the math here (testable, headless)
// means a transcription bug surfaces in CI, not as a wrong color in-viewer.
//
// Conventions: all functions are pure and stateless; vectors are passed as
// loose components to stay allocation-free and trivially mirrorable in GLSL.

// --- shader dimensions -----------------------------------------------------
/** Max substituted directional lights handed to the shader in place of the
 *  game's four dynamic-light loops. This is a shader constant (the fragment's
 *  light-accumulation loop bound), so it lives here in the constant SSOT; the
 *  viewer's `lightingRig` re-exports and fills it. The studio presets use <=3
 *  directionals. */
export const MAX_RIG_LIGHTS = 4;

// --- acos polynomial (asm 448-455) -----------------------------------------
// The shader approximates acos(x) for the toon-ramp angle with a degree-3
// polynomial x sqrt(1-|x|), reflected across 0. Same approximation used by the
// dynamic-light, point-light and spot-light loops (byte-identical inline copies).
export const ACOS_C0 = 1.5707288; //  asm 1.57072878
export const ACOS_C1 = -0.2121144; //  asm -2.12114394e-1
export const ACOS_C2 = 0.0742611; //  asm  7.42610022e-2
export const ACOS_C3 = -0.0187293; //  asm -1.87292993e-2

/** acos(x) ~, x in [-1,1] -> [0,pi]. Faithful to asm 446-455. */
export function acosApprox(x: number): number {
  const ax = Math.abs(x);
  const s = Math.sqrt(Math.max(0, 1 - ax));
  const p = ((ACOS_C3 * ax + ACOS_C2) * ax + ACOS_C1) * ax + ACOS_C0;
  const q = s * p; // = acos(|x|)
  return x < 0 ? Math.PI - q : q; // acos(-|x|) = pi - acos(|x|)
}

// --- toon ramp U coordinate (asm 456, 468) ---------------------------------
export const TWO_OVER_PI = 0.6366197724; // asm 6.36619747e-1
export const TOON_U_SCALE = 0.495; // asm 4.95000005e-1
export const TOON_U_BIAS = 0.5; // asm 5.0e-1

/** Angular half-lambert wrap: 1 - (2/pi)*acos(NdotL) = (2/pi)*asin(NdotL),
 *  in [-1,1] (asm 456: `mad -acos, 0.63662, 1.0`). NdotL clamped to [-1,1] by
 *  the caller. (TWO_OVER_PI is the 2/pi literal - not multiplied again.) */
export function toonWrap(ndotl: number): number {
  return 1 - acosApprox(ndotl) * TWO_OVER_PI;
}

/** Toon-ramp texture U from NdotL (asm 468): `wrap*0.495 + 0.5` in [0.005,0.995]. */
export function toonRampU(ndotl: number): number {
  return toonWrap(ndotl) * TOON_U_SCALE + TOON_U_BIAS;
}

// --- order-2 SH irradiance (asm 123-140) -----------------------------------
// Classic Ramamoorthi reconstruction with the asm's exact band literals. The
// 27-float coeff layout matches lightingRig.ts: [c00, c1-1, c10, c11, c2-2,
// c2-1, c20, c21, c22] x rgb -> cb0[1062..1070]. Returns the raw reconstructed
// RGB (the caller applies max(0,*), x albedo, x shScale, x 1/pi - asm 141-144).
export const SH_L0 = 0.8862269254; // asm 8.86226952e-1  (a0*Y00)
export const SH_L1 = 1.0233267546; // asm 1.02332675e0   (a1*Y1)
export const SH_L2_CROSS = 0.8580855131; // asm 8.58085513e-1  (a2*Y2_2)
export const SH_L2_M0 = 0.247707963; // asm 2.47707963e-1  (a2*Y20)
export const SH_L2_M2 = 0.4290427567; // asm 4.29042757e-1  (a2*Y22)
export const INV_PI = 0.3183098862; // asm 3.18309873e-1

/** Reconstruct SH irradiance (pre-max, pre-scale) at unit normal (nx,ny,nz)
 *  for one RGB channel. `coeffs` is the 27-float pack; `ch` in {0,1,2}. */
export function evalSH9Channel(
  coeffs: ArrayLike<number>,
  nx: number,
  ny: number,
  nz: number,
  ch: number,
): number {
  const c = (i: number): number => coeffs[i * 3 + ch];
  const l1 = -(nx * c(3) + ny * c(1) + nz * c(2)); // asm 137-139 (sign-flipped, self-cancels)
  const cross = nx * ny * c(4) + ny * nz * c(5) + nx * nz * c(7); // asm 130-135
  return (
    SH_L0 * c(0) +
    SH_L1 * l1 +
    SH_L2_CROSS * cross +
    SH_L2_M0 * (3 * nz * nz - 1) * c(6) +
    SH_L2_M2 * (nx * nx - ny * ny) * c(8)
  );
}

/** Full RGB SH irradiance reconstruction at a unit normal. */
export function evalSH9(
  coeffs: ArrayLike<number>,
  nx: number,
  ny: number,
  nz: number,
): [number, number, number] {
  return [
    evalSH9Channel(coeffs, nx, ny, nz, 0),
    evalSH9Channel(coeffs, nx, ny, nz, 1),
    evalSH9Channel(coeffs, nx, ny, nz, 2),
  ];
}

// --- fresnel inner-glow A (asm 762-775) ------------------------------------
/**
 * Inner-glow A fresnel factor. `base` = InnerGrowABase = [exp, scale, mode]
 * (cb0[1047]; Dorugamon = [40, 10, 1]). When mode == 1.0 the bias path uses a
 * near-binary -0.999 / x1000 envelope (a hard rim); otherwise it normalizes by
 * (1 - mode). Caller multiplies the result by InnerGrowAColor and the spec mask.
 */
export function innerGrowA(ndotv: number, base: ArrayLike<number>): number {
  const exp = base[0];
  const scale = base[1];
  const mode = base[2];
  const f = 1 - ndotv; // fresnel base
  const ratio = Math.max(f / (exp * ndotv + f), 0);
  const bias = mode === 1.0 ? -0.999 : -mode;
  const t = Math.max(ratio * scale + bias, 0);
  const inv = 1 / (bias + 1);
  return clamp01(t * inv);
}

// --- fresnel inner-glow B (asm 778-787) ------------------------------------
/**
 * Inner-glow B blend factor. `base` = InnerGrowBColor = [exp, scale, zbias]
 * (cb0[1048]; Dorugamon = [0.2,0.2,0.2], which evaluates ~0). Returns the
 * glow-source blend weight (min'd to 1).
 */
export function innerGrowB(ndotv: number, base: ArrayLike<number>): number {
  const exp = base[0];
  const scale = base[1];
  const zbias = Math.min(base[2], 0.999);
  const f = 1 - ndotv;
  const ratio = Math.max(f / (exp * ndotv + f), 0);
  return Math.min(Math.max(ratio * scale - zbias, 0) / (1 - zbias), 1);
}

// --- ordered Bayer screen-door threshold (asm 842-846) ---------------------
// The 4x4 dither matrix, authored as n/17 floats exactly as the asm's dp4 row
// weights. Indexed BAYER17[ix][iy] (asm picks row by screen-x, column by
// screen-y). Distinct from CoverSampler's n/16 matrix - this shader uses /17.
export const BAYER17: readonly (readonly number[])[] = [
  [0.0588235296, 0.764705896, 0.235294119, 0.941176474], // x17 = [ 1,13, 4,16]
  [0.529411793, 0.294117659, 0.70588237, 0.470588237], // x17 = [ 9, 5,12, 8]
  [0.176470593, 0.882352948, 0.117647059, 0.823529422], // x17 = [ 3,15, 2,14]
  [0.647058845, 0.411764711, 0.588235319, 0.352941185], // x17 = [11, 7,10, 6]
];

/** Bayer threshold for integer screen indices ix,iy in [0,3]. */
export function bayerThreshold(ix: number, iy: number): number {
  return BAYER17[ix & 3][iy & 3];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
