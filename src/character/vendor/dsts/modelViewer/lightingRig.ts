// Viewer-owned lighting rig for the ported chr cel/eye shader (ChrCelEffect).
//
// The game's chr fragment shader reads its environment from runtime engine
// buffers: 9 spherical-harmonic ambient coefficients (cb0[1062..1070]), four
// dynamic-light loops, and fog (cb0[1072]). We do NOT have those captured
// values, and we deliberately don't want them - the viewer owns its own
// studio lighting so lights can orbit and presets can change. This module
// SYNTHESIZES the same uniforms from the viewer's own `THREE.Light` rig
// (`lighting.ts` presets), so the faithful GLSL transcription runs unchanged
// against viewer-controllable input.
//
// SH derivation (must stay in lock-step with `evalSH9` in chrCel.math.ts /
// chrCel.glsl.ts). The asm evaluates order-2 SH irradiance in the classic
// Ramamoorthi form with band gains a0=pi, a1=2pi/3, a2=pi/4 folded into its
// reconstruction literals. We project each light into the SAME basis the asm
// reconstructs with, storing the raw radiance coefficients c_lm = C*Y_lm(d):
// reconstruction then yields C*clampedCosine(N*d) (Lambert) for a directional
// light, and a soft up/down gradient for a hemisphere light. The asm's L1 band
// carries a global sign flip vs. textbook real SH; it is self-cancelling
// (projection and reconstruction share the convention) but we keep it so the
// stored coefficients are directly comparable to a captured cb0[1062..1070].
//
// Pure and unit-tested (`lightingRig.test.ts`): the projection helpers take
// plain numbers, so tests assert evalSH9(coeffs, N) without constructing a
// scene.

import * as THREE from 'three';

// MAX_RIG_LIGHTS is a shader constant (the fragment's light-loop bound), so its
// SSOT is chrCel.math.ts. Re-exported here for the rig's own consumers/tests.
import { MAX_RIG_LIGHTS } from '../effects/chrCel.math';
export { MAX_RIG_LIGHTS };

/** Synthesized uniforms the ChrCel shader material consumes. Mirrors the
 *  game's cb0 layout for the pieces the rig owns. */
export interface LightingRigUniforms {
  /** 9 SH RGB coefficients, packed [c00.rgb, c1-1.rgb, c10.rgb, c11.rgb,
   *  c2-2.rgb, c2-1.rgb, c20.rgb, c21.rgb, c22.rgb] -> cb0[1062..1070]. */
  shCoeffs: Float32Array; // length 27
  /** SH intensity scale (cb0[1061].x). Rig-owned; 1.0 unless brightness-scaled. */
  shScale: number;
  /** Flat fill light added post-lighting (cb0[1016].w*xyz). RGB. */
  fillColor: Float32Array; // length 3
  /** Substituted directional-light directions (surface->light, unit), packed
   *  xyz per light, up to MAX_RIG_LIGHTS. */
  lightDirs: Float32Array; // length 3*MAX_RIG_LIGHTS
  /** Matching radiances (color*intensity) for `lightDirs`. */
  lightColors: Float32Array; // length 3*MAX_RIG_LIGHTS
  /** Number of valid entries in lightDirs/lightColors. */
  numLights: number;
  /** Fog color (cb0[1072].xyz). */
  fogColor: Float32Array; // length 3
  /** Fog amount (cb0[1072].w); 0 = no fog. */
  fogAmount: number;
}

// --- SH basis constants (asm Y convention; see header) ---------------------
const Y00 = 0.2820947918; //  1/(2*sqrt(pi))
const Y1 = 0.4886025119; //  sqrt(3/4pi)
const Y2_2 = 1.0925484306; //  sqrt(15/4pi)  - xy, yz, xz cross terms
const Y20 = 0.3153915652; //  sqrt(5/16pi)  - (3z^2-1)
const Y22 = 0.5462742153; //  sqrt(15/16pi) - (x^2-y^2)
const FOUR_PI = 4 * Math.PI;
const FOUR_PI_3 = FOUR_PI / 3;

/**
 * Accumulate a directional light (radiance `c` RGB, unit direction `d` =
 * surface->light) into the 27-float SH coefficient array, asm Y convention.
 * Exported for unit testing.
 */
export function accumulateDirectionalSH(
  out: Float32Array,
  d: { x: number; y: number; z: number },
  c: { r: number; g: number; b: number },
): void {
  // Per-band Y_lm(d), L1 carrying the asm's sign flip.
  const yl: number[] = [
    Y00, // c00
    -Y1 * d.y, // c1,-1
    -Y1 * d.z, // c1,0
    -Y1 * d.x, // c1,1
    Y2_2 * d.x * d.y, // c2,-2
    Y2_2 * d.y * d.z, // c2,-1
    Y20 * (3 * d.z * d.z - 1), // c2,0
    Y2_2 * d.x * d.z, // c2,1
    Y22 * (d.x * d.x - d.y * d.y), // c2,2
  ];
  for (let i = 0; i < 9; i++) {
    out[i * 3 + 0] += c.r * yl[i];
    out[i * 3 + 1] += c.g * yl[i];
    out[i * 3 + 2] += c.b * yl[i];
  }
}

/**
 * Accumulate a hemisphere light (sky/ground radiance RGB) into the SH array.
 * three.js HemisphereLight is a linear y-blend `mix(ground, sky, 0.5+0.5*y)`,
 * i.e. radiance A + B*y with A=(sky+ground)/2, B=(sky-ground)/2 - so only the
 * DC (c00) and the y-aligned L1 (c1,-1) bands are nonzero. Exported for tests.
 */
export function accumulateHemisphereSH(
  out: Float32Array,
  sky: { r: number; g: number; b: number },
  ground: { r: number; g: number; b: number },
): void {
  const cDC = FOUR_PI * Y00; // integral Y00 over the sphere
  const cY = -Y1 * FOUR_PI_3; // integral y*Y1,-1
  const ar = (sky.r + ground.r) / 2;
  const ag = (sky.g + ground.g) / 2;
  const ab = (sky.b + ground.b) / 2;
  const br = (sky.r - ground.r) / 2;
  const bg = (sky.g - ground.g) / 2;
  const bb = (sky.b - ground.b) / 2;
  out[0] += cDC * ar;
  out[1] += cDC * ag;
  out[2] += cDC * ab;
  out[3] += cY * br; // c1,-1 (y band)
  out[4] += cY * bg;
  out[5] += cY * bb;
}

interface RigOptions {
  /** SH/light intensity scale (the Brightness slider). Default 1. */
  brightness?: number;
  /** Fog color + amount. Default: no fog. */
  fog?: { color: THREE.ColorRepresentation; amount: number } | null;
}

/**
 * Synthesize the chr-shader lighting uniforms from the viewer's THREE light
 * rig. Hemisphere/Ambient lights feed the SH ambient; Directional lights feed
 * both the SH ambient and the substituted dynamic-light list (capped at
 * MAX_RIG_LIGHTS). Point/Spot lights are ignored (studio rig has none).
 */
export function computeLightingRig(
  lights: readonly THREE.Light[],
  opts: RigOptions = {},
): LightingRigUniforms {
  const brightness = opts.brightness ?? 1;
  const shCoeffs = new Float32Array(27);
  const lightDirs = new Float32Array(3 * MAX_RIG_LIGHTS);
  const lightColors = new Float32Array(3 * MAX_RIG_LIGHTS);
  let numLights = 0;

  const tmp = new THREE.Color();
  for (const light of lights) {
    const intensity = light.intensity;
    if (light instanceof THREE.HemisphereLight) {
      const sky = tmp.copy(light.color).multiplyScalar(intensity);
      const skyRGB = { r: sky.r, g: sky.g, b: sky.b };
      const grd = new THREE.Color().copy(light.groundColor).multiplyScalar(intensity);
      accumulateHemisphereSH(shCoeffs, skyRGB, { r: grd.r, g: grd.g, b: grd.b });
    } else if (light instanceof THREE.AmbientLight) {
      const c = tmp.copy(light.color).multiplyScalar(intensity);
      accumulateHemisphereSH(shCoeffs, { r: c.r, g: c.g, b: c.b }, { r: c.r, g: c.g, b: c.b });
    } else if (light instanceof THREE.DirectionalLight) {
      // DirectionalLight points from .position toward its target (origin by
      // default) - so surface->light direction is the normalized position.
      const dir = new THREE.Vector3().copy(light.position);
      if (dir.lengthSq() < 1e-8) continue;
      dir.normalize();
      const c = tmp.copy(light.color).multiplyScalar(intensity);
      accumulateDirectionalSH(shCoeffs, dir, { r: c.r, g: c.g, b: c.b });
      if (numLights < MAX_RIG_LIGHTS) {
        lightDirs[numLights * 3 + 0] = dir.x;
        lightDirs[numLights * 3 + 1] = dir.y;
        lightDirs[numLights * 3 + 2] = dir.z;
        lightColors[numLights * 3 + 0] = c.r;
        lightColors[numLights * 3 + 1] = c.g;
        lightColors[numLights * 3 + 2] = c.b;
        numLights++;
      }
    }
  }

  const fog = opts.fog ?? null;
  const fogColor = new Float32Array(3);
  if (fog) {
    const fc = new THREE.Color(fog.color);
    fogColor[0] = fc.r;
    fogColor[1] = fc.g;
    fogColor[2] = fc.b;
  }

  return {
    shCoeffs,
    shScale: brightness,
    fillColor: new Float32Array(3), // no extra fill in v1; SH ambient covers it
    lightDirs,
    lightColors,
    numLights,
    fogColor,
    fogAmount: fog ? fog.amount : 0,
  };
}
