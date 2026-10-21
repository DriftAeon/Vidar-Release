// Viewer-side per-pixel rasterizer for the DSTS eye-overlay composite.
//
// Replaces what the exporter used to bake (`compose_eye_overlay_texture`
// in src/exporter/eyes.py) so the GLB itself stays strictly canonical.
// Algorithm mirrors the in-game eye-overlay fragment shader's color block,
// applied once per material at load time:
//
//   for each triangle of the eye-overlay mesh:
//     for each pixel inside the triangle (canvas space == UV3):
//       a = a01[uv1_interp]       # body skin
//       p = p01[uv2_interp]       # iris/pupil disc (UV2 indexes into p01)
//       b = b01[uv3_pixel]        # sclera + iris-hole alpha (canvas == b01)
//       step1 = lerp(a, p, p.alpha)        # iris over body
//       final = lerp(step1, b, b.alpha)    # sclera over (iris + body)
//
// The shader's natural ordering handles the iris-hole without an explicit
// clip: sclera alpha is 0 at the iris hole, so the iris from step1 shines
// through.
//
// Eye meshes come in two shapes; both run the same blend math:
//   - iris (3 UV sets): the full formula above. The iris atlas is named
//     either `p01` (clockmon, wisemon) or `b01p` (octomon, andromon).
//   - mask (2 UV sets): no iris atlas at all (skullgreymon, devimon,
//     icedevimon). step1 collapses to a01, so final = lerp(a01, b01,
//     b01.alpha) - DXBC-confirmed on skullgreymon's eye `_fp.shad`. The
//     "black background" is b01's dark-socket RGB where its alpha is high.
//
// Source atlases are resolved by stem family, not slot name: the sclera
// (`b01`) and iris (`p01`/`b01p`) ride different uniform slots across chrs
// (`OverlayColorSampler3` vs `OverlayNormalSampler`), so we scan
// `texture_slots` for the matching stem.
//
// UV channels: the iris is sampled at UV2; b01 is sampled at UV3 - confirmed
// by DXBC disassembly. Earlier code had them swapped, which was undetectable
// on Guilmon (UV2 == UV3 per-vertex) but produced cross-eyed/bug-eyed
// results on chrs where the artist authored a real UV2/UV3 offset (Salamon,
// Coronamon, Huckmon, Gazimon, Gizamon). Mask-shape meshes carry only 2 UV
// sets, so `getUVAttribute(geom, 2)` falls back to UV2 and b01 samples there.
//
// All four expression rows (open/closed/smile/angry) bake into one 4-row
// canvas matching b01's layout, so the existing EyeOverlayScrollEffect
// keeps working by shifting `tex.offset.y` between rows.

import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getDstsExtras } from '../modelViewer/shaderRegistry';
import {
  decodeUnpremultiplied,
  resolveTextureByIndex,
  type PixelData,
} from '../modelViewer/textureDecode';

/**
 * Bake the eye-overlay composite for every eye-overlay material in `gltf.scene`,
 * replacing each material's `map` with the freshly-composed CanvasTexture.
 *
 * Resolves the three source atlases via `extras.dsts.texture_indices` (post-
 * bundler GLBs) and falls back to `tex.image.name`-matching for backwards
 * compatibility with older exports. Skips materials whose source atlases
 * can't be located.
 *
 * Returns the number of materials whose map was replaced - `0` is normal for
 * models without eye overlays (most NPCs).
 */
export async function bakeEyeOverlay(gltf: GLTF): Promise<number> {
  const root = gltf.scene;
  const meshesByMaterial = collectEyeOverlayMeshesByMaterial(root);
  if (meshesByMaterial.size === 0) return 0;

  let baked = 0;

  for (const [mat, meshes] of meshesByMaterial) {
    const sources = await resolveSourceTextures(gltf, mat);
    if (!sources) continue;
    const params = readNormalParams(mat, sources);
    const composed = composeEyeOverlay(meshes, sources, params);
    if (!composed) continue;
    const channel = eyeOverlayUVChannel(meshes);
    applyComposedMap(mat, composed.color, channel);
    if (composed.normal) applyComposedNormal(mat, composed.normal, channel, params.scale);
    baked++;
  }
  return baked;
}

interface SourceTextures {
  readonly a01: PixelData;
  readonly b01: PixelData;
  // Iris atlas (`p01` or `b01p` family). Null on "mask"-shape eye meshes
  // that carry no iris layer (skullgreymon, devimon, icedevimon) - the
  // composite reduces to lerp(a01, b01, b01.alpha).
  readonly p01: PixelData | null;
  readonly b01Texture: THREE.Texture;
  // Normal-map sources for the eye-overlay NORMAL composite, RE'd from
  // woodmon's eye `_fp.shad` (lines 94-111; notes/chr-cel-eye-normal-re.md):
  //   N = normalize(N_geo + w_body*(a01n.xy-0.5)*TB + w_eye*(b01n.xy-0.5)*TB)
  // `a01n` is the body normal (Bumpiness slot); `b01n` is the eye-overlay
  // normal (OverlayNormalSampler3). Either may be null - a01n null skips
  // normal baking entirely; b01n null bakes the body-normal term alone (its
  // coverage still fades the bump out under the iris/sclera). See
  // `composeEyeNormalOffset`.
  readonly a01n: PixelData | null;
  readonly b01n: PixelData | null;
}

/** Per-material weights for the eye-overlay normal composite (the cb0 reads in
 *  the disassembled blend). `scale` is the encode range for the baked offset
 *  texture (see `composeEyeOverlay`) and is mirrored onto `material.normalScale`
 *  so chr-cel's standard normal path recovers the raw offset. */
interface NormalParams {
  readonly sIris: number; // OverlayStrength  (cb0[1020].x) - iris coverage weight
  readonly sB01: number; // OverlayStrength3 (cb0[1020].y) - sclera coverage weight
  readonly kBody: number; // cb0[1018].x - body bump scale (audit: 1.0 neutral)
  readonly kEye: number; // OverlayBumpiness3 (cb0[1020].z) - eye bump scale
  readonly scale: number; // baked-offset encode range (>= max |offset|)
}

/**
 * Build the material -> meshes map for every eye-overlay material in the
 * scene. Signature: `texture_slots` carries a `b01` family stem (same
 * predicate `EyeOverlayScrollEffect` uses for row scrolling).
 */
function collectEyeOverlayMeshesByMaterial(
  root: THREE.Object3D,
): Map<THREE.Material, THREE.Mesh[]> {
  const out = new Map<THREE.Material, THREE.Mesh[]>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat || !isEyeOverlayMaterial(mat)) continue;
      let list = out.get(mat);
      if (!list) {
        list = [];
        out.set(mat, list);
      }
      list.push(mesh);
    }
  });
  return out;
}

/**
 * Match any eye-overlay material: one whose `texture_slots` bind a `b01`
 * family sclera/eyelid atlas (a stem ending exactly `b01`). The iris layer
 * (`p01` or `b01p`) is optional - "mask"-shape eyes (skullgreymon, devimon,
 * icedevimon) carry only `b01` and composite as lerp(a01, b01, b01.alpha).
 *
 * Exported so `EyeOverlayScrollEffect` shares the exact same predicate,
 * keeping baked-canvas row scrolling in lockstep with what we composite.
 *
 * `endsWith('b01')` deliberately excludes the `b01p` iris (ends `b01p`),
 * the `b01m` mask atlas (ends `b01m`), and the `b01em` glow (ends `b01em`).
 */
export function isEyeOverlayMaterial(mat: THREE.Material): boolean {
  const slots = getDstsExtras(mat)?.texture_slots;
  if (!slots) return false;
  const entries = Object.entries(slots);
  if (!entries.some(([, stem]) => stem.endsWith('b01'))) return false;

  // `b01` is a generic secondary-overlay atlas, not exclusively an eye texture.
  // A few chrs bind it as a body surface-detail overlay through a NORMAL slot
  // rather than as an eye sclera. Solarmon's main body (`chr728`,
  // OverlayNormalSampler=chr728b01) is the roster's only FULL body that does so,
  // and baking the eye composite over it smears the sclera across his whole
  // body (he rendered gray/black instead of orange). Distinguish real eyes: they
  // bind their sclera on a COLOR slot (`OverlayColorSampler*`) or carry an iris
  // (`p01`/`b01p`). A mesh with neither that ALSO reflects the env cubemap
  // (`chr_env`) is a reflective body, not an eye card - skip it. Mask-shape eyes
  // (skullgreymon) are non-reflective, so they still bake.
  const hasColorSclera = entries.some(
    ([slot, stem]) => stem.endsWith('b01') && /color/i.test(slot),
  );
  const hasIris = entries.some(([, stem]) => isIrisStem(stem));
  const reflective = entries.some(([, stem]) => stem === 'chr_env');
  if (reflective && !hasColorSclera && !hasIris) return false;
  return true;
}

/** True for an iris-atlas stem in any of its naming conventions: `p01`
 *  (clockmon, wisemon), or the `...01p` suffix variants `b01p` (octomon,
 *  andromon) and `a01p` (groundlocomon). */
export function isIrisStem(stem: string): boolean {
  return stem.endsWith('p01') || stem.endsWith('01p');
}

/** Does this material's emissive map ride UV2 - the eye/face expression-row atlas
 *  that EyeOverlayScrollEffect walks - rather than the diffuse UV0? True ONLY for
 *  eye/face overlays, whose emissive is an iris (`p01`/`01p`) or sclera (`b01`)
 *  expression atlas. The body-glow emissive (`LightPixelProj` -> `<model>a##em`)
 *  is sampled on UV0: the game reads it at the diffuse UV, same as the flesh (RE:
 *  meramon / alphamon body fp). Keying on the em atlas family - NOT "the mesh
 *  carries a UV2 stream" - is what keeps meramon-family fire bodies (which DO carry
 *  UV2) from tiling their a01em body glow across the mesh on UV2. */
export function isExpressionEmissiveMaterial(mat: THREE.Material): boolean {
  const em = getDstsExtras(mat)?.texture_slots?.LightPixelProj;
  if (!em) return false;
  // Iris (`p01`/`01p`) or any `b01`-family sclera/overlay glow (`b01`, `b01em`,
  // `b01p`). Body glow is the `a##em` family (`a01em`, `a02em`) - never `b01`/`p01`.
  return isIrisStem(em) || em.includes('b01');
}

/** Find the slot whose bound stem satisfies `pred`, or null. The sclera /
 *  iris slot names vary across chrs (`OverlayColorSampler3` vs
 *  `OverlayNormalSampler`), so we key off the stem family rather than the
 *  uniform name. */
function findSlotByStem(
  slots: Record<string, string>,
  pred: (stem: string) => boolean,
): string | null {
  for (const [slot, stem] of Object.entries(slots)) {
    if (pred(stem)) return slot;
  }
  return null;
}

/**
 * Resolve which `texture_slots` entries play the sclera (`b01`) and iris
 * (`p01`/`b01p`) roles on an eye-overlay material, keying off stem family
 * rather than slot name (slot names differ across chrs). `b01Slot` is null
 * on a non-eye material; `irisSlot` is null on mask-shape eyes. Pure +
 * exported for unit tests.
 */
export function resolveEyeSourceSlots(slots: Record<string, string> | undefined): {
  b01Slot: string | null;
  irisSlot: string | null;
} {
  if (!slots) return { b01Slot: null, irisSlot: null };
  return {
    b01Slot: findSlotByStem(slots, (s) => s.endsWith('b01')),
    irisSlot: findSlotByStem(slots, isIrisStem),
  };
}

/**
 * Resolve the source atlases the rasterizer needs.
 *
 * `b01` (sclera/eyelid) and the optional iris (`p01`/`b01p`) are resolved by
 * stem family - the owning slot name varies across chrs (`OverlayColorSampler3`
 * vs `OverlayNormalSampler`), so we scan `texture_slots` for the matching stem
 * and look its glTF index up via the parallel `texture_indices` map. The iris
 * is optional: "mask"-shape eyes bind only `b01` and skip step 1 entirely.
 *
 * The bare `a01` body diffuse isn't bound to a named slot on eye-overlay
 * materials - the engine derives it implicitly. We mirror the exporter's
 * recolor rule: prefer `<model_id>a01` when bundled (palette swaps like Lopmon
 * and Muchomon ship their own a01), falling back to the n-stripped Bumpiness
 * stem when no own a01 is present.
 */
async function resolveSourceTextures(
  gltf: GLTF,
  mat: THREE.Material,
): Promise<SourceTextures | null> {
  const dsts = getDstsExtras(mat);
  if (!dsts) return null;

  const { b01Slot, irisSlot } = resolveEyeSourceSlots(dsts.texture_slots);
  if (!b01Slot) return null;
  const b01TexIdx = dsts.texture_indices?.[b01Slot] ?? null;
  if (b01TexIdx === null) return null;

  const irisTexIdx = irisSlot ? (dsts.texture_indices?.[irisSlot] ?? null) : null;

  const b01Tex = await resolveTextureByIndex(gltf, b01TexIdx);
  if (!b01Tex) return null;

  const a01TexIdx = await resolveBodyDiffuseTextureIndex(gltf, dsts);
  if (a01TexIdx === null) return null;

  // Decode the source PNGs directly from the GLB buffer with
  // `premultiplyAlpha: 'none'`. Three's GLTFLoader pipes textures through
  // createImageBitmap with the browser's default - Chrome premultiplies,
  // zeroing RGB at alpha=0 pixels. The composite formula only references
  // b01.RGB when bA=0 (where step1=a01 anyway), but the canvas's INITIAL
  // drawImage (the safety-net background for pixels outside any mesh
  // triangle) ends up black there. Visible as the four black marker
  // squares on Tanemon's face - the eye-overlay mesh's UV2 sampling
  // reaches the canvas's left-edge alpha=0 padding rows the artist
  // authored as transparent-tan, which premultiplication zeroed to
  // transparent-black.
  const a01Pixels = await decodeUnpremultiplied(gltf, a01TexIdx);
  const b01Pixels = await decodeUnpremultiplied(gltf, b01TexIdx);
  if (!a01Pixels || !b01Pixels) return null;

  let p01Pixels: PixelData | null = null;
  if (irisTexIdx !== null) {
    p01Pixels = await decodeUnpremultiplied(gltf, irisTexIdx);
    if (!p01Pixels) return null;
  }

  // Normal sources. a01n rides the named `Bumpiness` slot; b01n is found by
  // stem (its slot name - `OverlayNormalSampler3` - is stable, but key off the
  // stem family for parity with the color resolution). Normal maps are LINEAR
  // data; decode bytes raw (un-premultiplied) like the color atlases. Missing
  // sources are tolerated: a01n absent -> no normal bake; b01n absent -> body
  // term only.
  const a01nTexIdx = dsts.texture_indices?.Bumpiness ?? null;
  const a01nPixels = a01nTexIdx !== null ? await decodeUnpremultiplied(gltf, a01nTexIdx) : null;
  const b01nSlot = findSlotByStem(dsts.texture_slots ?? {}, (s) => s.endsWith('b01n'));
  const b01nTexIdx = b01nSlot ? (dsts.texture_indices?.[b01nSlot] ?? null) : null;
  const b01nPixels = b01nTexIdx !== null ? await decodeUnpremultiplied(gltf, b01nTexIdx) : null;

  return {
    a01: a01Pixels,
    b01: b01Pixels,
    p01: p01Pixels,
    b01Texture: b01Tex,
    a01n: a01nPixels,
    b01n: b01nPixels,
  };
}

/**
 * Read the eye-overlay normal-composite weights from the material's canonical
 * uniforms. `OverlayStrength`/`OverlayStrength3` default to 1 (the implicit
 * coverage weight the color bake already assumes); `kBody` is the audit-
 * confirmed neutral 1.0 (cb0[1018].x = [1,1,1,0]); `kEye` (OverlayBumpiness3)
 * defaults to 1 when unstamped. `scale` over-estimates the largest possible
 * offset magnitude - body term <= 0.5*kBody, eye term <= 0.5*kEye - so the baked
 * 8-bit encode never clips.
 */
function readNormalParams(mat: THREE.Material, src: SourceTextures): NormalParams {
  const u = getDstsExtras(mat)?.uniforms ?? {};
  const sIris = u.OverlayStrength?.[0] ?? 1;
  const sB01 = u.OverlayStrength3?.[0] ?? 1;
  const kBody = 1; // cb0[1018].x - neutral (notes/chr_ubershader_cb0_audit.md)
  const kEye = u.OverlayBumpiness3?.[0] ?? 1;
  const eyeTerm = src.b01n ? kEye : 0;
  const scale = Math.max(0.5, 0.5 * kBody + 0.5 * eyeTerm);
  return { sIris, sB01, kBody, kEye, scale };
}

/**
 * Ordered body-diffuse stem candidates for an eye-overlay material. The bare
 * body diffuse isn't bound to a named slot, so we infer it from the mesh's
 * Bumpiness (normal map) - whose atlas family IS the diffuse's (`a02n` ->
 * `a02`, `a01n` -> `a01`).
 *
 * The `<model_id>a01` recolor override applies ONLY to a FOREIGN Bumpiness
 * borrow: palette-swap recolors (Lopmon, Muchomon, BlueMeramon, ...) point
 * Bumpiness at the base chr's `a01n` but ship their own `a01`, which must
 * win. When the Bumpiness is the SAME model's own atlas, the mesh's choice
 * stands - megagargomon's eye meshes deliberately use `a02` (a02n Bumpiness),
 * and forcing `a01` bled the green body diffuse through the white sclera.
 *
 * `bumpinessStem` is the already-n-stripped diffuse stem (or undefined).
 * Pure + exported for unit tests.
 */
export function bodyDiffuseCandidates(
  modelId: string | undefined,
  bumpinessStem: string | undefined,
): string[] {
  const modelA01 = modelId ? `${modelId}a01` : null;
  const foreign = !!bumpinessStem && !!modelId && !bumpinessStem.startsWith(modelId);
  const ordered = foreign ? [modelA01, bumpinessStem] : [bumpinessStem, modelA01];
  // De-dupe (same-model a01 yields modelA01 twice) and drop nulls.
  return ordered.filter((s, i): s is string => !!s && ordered.indexOf(s) === i);
}

async function resolveBodyDiffuseTextureIndex(
  gltf: GLTF,
  dsts: NonNullable<ReturnType<typeof getDstsExtras>>,
): Promise<number | null> {
  const bumpiness = dsts.texture_slots?.Bumpiness;
  const bumpinessStem = bumpiness && bumpiness.endsWith('n') ? bumpiness.slice(0, -1) : undefined;
  for (const stem of bodyDiffuseCandidates(dsts.model_id, bumpinessStem)) {
    const idx = lookupTextureIndexByImageName(gltf, stem);
    if (idx !== null) return idx;
  }
  return null;
}

function lookupTextureIndexByImageName(gltf: GLTF, stem: string): number | null {
  const images = (gltf.parser.json.images ?? []) as Array<{ name?: string }>;
  const textures = (gltf.parser.json.textures ?? []) as Array<{ source?: number }>;
  const imageIndex = images.findIndex((img) => img.name === stem);
  if (imageIndex < 0) return null;
  const textureIndex = textures.findIndex((tex) => tex.source === imageIndex);
  return textureIndex < 0 ? null : textureIndex;
}

const NUM_ATLAS_ROWS = 4;

/** The composed eye-overlay outputs: the color atlas (always) and the
 *  tangent-space normal atlas (only when a body normal `a01n` was resolved). */
interface ComposedEyeMaps {
  readonly color: HTMLCanvasElement;
  readonly normal: HTMLCanvasElement | null;
}

/**
 * Walk every eye-overlay triangle and write the in-game composite into a
 * canvas matching `b01`'s dimensions. Bakes the color composite (always) and,
 * when `a01n` is present, the tangent-space normal composite into a second
 * canvas. Returns both, or `null` if the canvas couldn't be allocated.
 */
function composeEyeOverlay(
  meshes: THREE.Mesh[],
  src: SourceTextures,
  params: NormalParams,
): ComposedEyeMaps | null {
  const canvasW = src.b01.width;
  const canvasH = src.b01.height;
  if (!canvasW || !canvasH) return null;

  // Init the output bytes by copying b01's un-premultiplied RGBA
  // directly. `src.b01.data` is the raw decoded PNG (see decodePng);
  // we never round-trip through canvas2D's getImageData, which would
  // zero RGB at alpha=0 pixels via its premultiplication divide.
  // The output canvas inherits b01's full RGB everywhere - important
  // for UV2-degenerate triangles whose canvas samples land on the
  // artist's alpha=0 padding-tone rows (Tanemon's four-square bug).
  const buffer = new ArrayBuffer(src.b01.data.byteLength);
  const out8 = new Uint8ClampedArray(buffer);
  out8.set(src.b01.data);
  // Force alpha=255 - canvas stays opaque end-to-end.
  for (let i = 3; i < out8.length; i += 4) out8[i] = 255;

  // Normal output (only when a body normal exists). Initialize every pixel to
  // the neutral tangent normal - offset (0,0), z=1 -> encoded RGB (128,128,255)
  // - so uncovered canvas regions read as "no perturbation".
  let normal8: Uint8ClampedArray | null = null;
  if (src.a01n) {
    normal8 = new Uint8ClampedArray(canvasW * canvasH * 4);
    for (let i = 0; i < normal8.length; i += 4) {
      normal8[i] = 128;
      normal8[i + 1] = 128;
      normal8[i + 2] = 255;
      normal8[i + 3] = 255;
    }
  }

  for (const mesh of meshes) {
    rasterizeMesh(mesh, {
      canvasW,
      canvasH,
      out: out8,
      normal: normal8,
      a01: src.a01,
      b01: src.b01,
      p01: src.p01,
      a01n: src.a01n,
      b01n: src.b01n,
      params,
    });
  }

  const color = canvasFromBytes(out8, canvasW, canvasH);
  if (!color) return null;
  const normal = normal8 ? canvasFromBytes(normal8, canvasW, canvasH) : null;
  return { color, normal };
}

/** Wrap RGBA bytes in a 2D canvas via putImageData. */
function canvasFromBytes(bytes: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement | null {
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.putImageData(new ImageData(bytes as any, w, h), 0, 0);
  return out;
}

interface RasterContext {
  canvasW: number;
  canvasH: number;
  out: Uint8ClampedArray;
  // Tangent-space normal output, parallel to `out`. Null when no body normal
  // was resolved (normal bake skipped).
  normal: Uint8ClampedArray | null;
  a01: PixelData;
  b01: PixelData;
  // Null on mask-shape eyes (no iris layer) - see SourceTextures.p01.
  p01: PixelData | null;
  // Normal sources; a01n drives the body term, b01n the eye term. a01n null =>
  // ctx.normal is also null (no normal output). See composeEyeNormalOffset.
  a01n: PixelData | null;
  b01n: PixelData | null;
  params: NormalParams;
}

function rasterizeMesh(mesh: THREE.Mesh, ctx: RasterContext): void {
  const geom = mesh.geometry as THREE.BufferGeometry;
  const positions = geom.getIndex();
  const uv1Attr = getUVAttribute(geom, 0);
  const uv2Attr = getUVAttribute(geom, 1);
  const uv3Attr: NonNullable<ReturnType<typeof getUVAttribute>> =
    getUVAttribute(geom, 2) ?? uv2Attr!;
  if (!uv1Attr || !uv2Attr) return;

  const triCount = positions ? positions.count / 3 : (uv1Attr.count / 3) | 0;

  for (let row = 0; row < NUM_ATLAS_ROWS; row++) {
    const rowShift = row / NUM_ATLAS_ROWS;
    for (let t = 0; t < triCount; t++) {
      const i0 = positions ? positions.getX(t * 3 + 0) : t * 3 + 0;
      const i1 = positions ? positions.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = positions ? positions.getX(t * 3 + 2) : t * 3 + 2;

      // Canvas-space triangle (UV3 shifted to row N) - the canvas IS b01,
      // and the in-game shader samples b01 at UV3.
      const c0x = uv3Attr.getX(i0) * ctx.canvasW;
      const c0y = (uv3Attr.getY(i0) + rowShift) * ctx.canvasH;
      const c1x = uv3Attr.getX(i1) * ctx.canvasW;
      const c1y = (uv3Attr.getY(i1) + rowShift) * ctx.canvasH;
      const c2x = uv3Attr.getX(i2) * ctx.canvasW;
      const c2y = (uv3Attr.getY(i2) + rowShift) * ctx.canvasH;

      // p01 (UV2 shifted to row N) - iris atlas, sampled via UV2. On mask-
      // shape eyes there's no iris; pass zeroed coords (unused downstream).
      const pW = ctx.p01?.width ?? 0;
      const pH = ctx.p01?.height ?? 0;

      rasterizeTriangle(
        ctx,
        c0x,
        c0y,
        c1x,
        c1y,
        c2x,
        c2y,
        // a01 (UV1) - not row-shifted (a01 is single-row).
        uv1Attr.getX(i0) * ctx.a01.width,
        uv1Attr.getY(i0) * ctx.a01.height,
        uv1Attr.getX(i1) * ctx.a01.width,
        uv1Attr.getY(i1) * ctx.a01.height,
        uv1Attr.getX(i2) * ctx.a01.width,
        uv1Attr.getY(i2) * ctx.a01.height,
        uv2Attr.getX(i0) * pW,
        (uv2Attr.getY(i0) + rowShift) * pH,
        uv2Attr.getX(i1) * pW,
        (uv2Attr.getY(i1) + rowShift) * pH,
        uv2Attr.getX(i2) * pW,
        (uv2Attr.getY(i2) + rowShift) * pH,
      );
    }
  }
}

/**
 * Three.js renamed the secondary UV channels between r150 and r155
 * (`uv2` -> `uv1` for TEXCOORD_1, `uv3` -> `uv2` for TEXCOORD_2). Look up
 * by both conventions so the rasterizer works regardless of three.js
 * version drift.
 *
 * This rasterizer samples raw UV attributes and does NOT apply any
 * `KHR_texture_transform` - so it assumes the atlas UVs map 1:1 to texel
 * space. For the meshopt `dsts-opt` delivery tree that holds ONLY because the
 * extractor builds those GLBs with `gltfpack -vtf` (float texcoords -> no UV
 * quantization -> no `KHR_texture_transform` emitted). If an opt build ever
 * drops `-vtf`, gltfpack remaps tight UV ranges onto the quantized range and
 * these raw reads land in the wrong place - bodies still render correctly (the
 * shader applies the transform) but authored-UV eye composites misregister.
 */
function getUVAttribute(
  geom: THREE.BufferGeometry,
  texcoordIndex: 0 | 1 | 2,
): THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null {
  if (texcoordIndex === 0) return (geom.getAttribute('uv') as THREE.BufferAttribute) ?? null;
  const newName = `uv${texcoordIndex}`;
  const oldName = `uv${texcoordIndex + 1}`;
  return (
    (geom.getAttribute(newName) as THREE.BufferAttribute | undefined) ??
    (geom.getAttribute(oldName) as THREE.BufferAttribute | undefined) ??
    null
  );
}

/**
 * Integer-shift a canvas extent into `[0, size)` when it lies ENTIRELY
 * outside - mirroring the GL REPEAT wrap the mesh samples the canvas with.
 * Some chrs author the eye mesh's UV3 in `[-1, 0)` (clockmon's head eyes
 * sit at v~-0.85, expecting a +1 wrap to ~0.15); without this their
 * triangles rasterize entirely off-canvas and the composite is never
 * written, so the eye samples the raw b01 init instead. Triangles that
 * already overlap the canvas (e.g. a strip straddling the v=0 seam) are
 * left untouched - shifting them would move pixels that currently land
 * correctly, so this can only ADD coverage, never regress it. Returns the
 * shift to add to all three canvas coords on that axis.
 */
export function wrapShift(lo: number, hi: number, size: number): number {
  if (hi >= 0 && lo < size) return 0; // overlaps the canvas - leave as-is.
  return -Math.floor(lo / size) * size;
}

/**
 * Walk every pixel inside the triangle's canvas-space AABB, barycentric-
 * interpolate the a01/p01 UV coordinates, sample all three atlases, and
 * composite per the in-game shader's color block. Pixels outside the
 * triangle are left untouched.
 */
function rasterizeTriangle(
  ctx: RasterContext,
  c0x: number,
  c0y: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  a0x: number,
  a0y: number,
  a1x: number,
  a1y: number,
  a2x: number,
  a2y: number,
  p0x: number,
  p0y: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): void {
  // Wrap canvas coords for meshes whose UV3 was authored outside [0,1)
  // (relies on the sampler's REPEAT mode). a01/p01 sample coords are
  // independent (wrapped at sample time via wrapPx) and untouched.
  const sx = wrapShift(Math.min(c0x, c1x, c2x), Math.max(c0x, c1x, c2x), ctx.canvasW);
  const sy = wrapShift(Math.min(c0y, c1y, c2y), Math.max(c0y, c1y, c2y), ctx.canvasH);
  c0x += sx;
  c1x += sx;
  c2x += sx;
  c0y += sy;
  c1y += sy;
  c2y += sy;

  const xLo = Math.max(0, Math.floor(Math.min(c0x, c1x, c2x)));
  const xHi = Math.min(ctx.canvasW, Math.ceil(Math.max(c0x, c1x, c2x)));
  const yLo = Math.max(0, Math.floor(Math.min(c0y, c1y, c2y)));
  const yHi = Math.min(ctx.canvasH, Math.ceil(Math.max(c0y, c1y, c2y)));
  if (xHi <= xLo || yHi <= yLo) return;

  const denom = (c1y - c2y) * (c0x - c2x) + (c2x - c1x) * (c0y - c2y);
  if (Math.abs(denom) < 1e-9) return;
  const invDenom = 1 / denom;

  for (let y = yLo; y < yHi; y++) {
    const yc = y + 0.5;
    for (let x = xLo; x < xHi; x++) {
      const xc = x + 0.5;
      const w0 = ((c1y - c2y) * (xc - c2x) + (c2x - c1x) * (yc - c2y)) * invDenom;
      const w1 = ((c2y - c0y) * (xc - c2x) + (c0x - c2x) * (yc - c2y)) * invDenom;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;

      // Sample a01 at the interpolated UV1. Wrap (mod width) instead of
      // clamping - some chrs author the L-side mesh's UV1 in the
      // [1.x, 2.x] range to flag the wrap to the in-game sampler (Guilmon's
      // chr090.002 mesh sits at u=[1.171, 1.315] and expects to land on
      // a01's eye-sclera column at u=[0.171, 0.315] after the wrap).
      const ax = (w0 * a0x + w1 * a1x + w2 * a2x) | 0;
      const ay = (w0 * a0y + w1 * a1y + w2 * a2y) | 0;
      const aIdx = (wrapPx(ay, ctx.a01.height) * ctx.a01.width + wrapPx(ax, ctx.a01.width)) * 4;

      // Sample b01 (sclera) at the canvas pixel itself - UV3 == canvas
      // pixel by construction, and the in-game shader samples b01 at UV3.
      const bIdx = (y * ctx.b01.width + x) * 4;

      // Sample the iris (p01) at the interpolated UV2, or pass a null iris
      // on mask-shape eyes so the composite reduces to lerp(a01, b01, bA).
      let iris: EyePixel | null = null;
      if (ctx.p01) {
        const px = (w0 * p0x + w1 * p1x + w2 * p2x) | 0;
        const py = (w0 * p0y + w1 * p1y + w2 * p2y) | 0;
        const pIdx = (wrapPx(py, ctx.p01.height) * ctx.p01.width + wrapPx(px, ctx.p01.width)) * 4;
        iris = {
          r: ctx.p01.data[pIdx + 0],
          g: ctx.p01.data[pIdx + 1],
          b: ctx.p01.data[pIdx + 2],
          a: ctx.p01.data[pIdx + 3] / 255,
        };
      }

      const [fR, fG, fB] = compositeEyePixel(
        ctx.a01.data[aIdx + 0],
        ctx.a01.data[aIdx + 1],
        ctx.a01.data[aIdx + 2],
        ctx.b01.data[bIdx + 0],
        ctx.b01.data[bIdx + 1],
        ctx.b01.data[bIdx + 2],
        ctx.b01.data[bIdx + 3] / 255,
        iris,
      );

      const oIdx = (y * ctx.canvasW + x) * 4;
      ctx.out[oIdx + 0] = fR;
      ctx.out[oIdx + 1] = fG;
      ctx.out[oIdx + 2] = fB;
      ctx.out[oIdx + 3] = 255;

      // Normal composite (disassembled blend; see composeEyeNormalOffset).
      // a01n shares a01's UV1 layout, b01n shares b01's UV3 (canvas pixel) -
      // sample each at the color atlases' coords. a01n/b01n may differ in
      // resolution from a01/b01; index by their own dims via wrapPx so a
      // size mismatch still wraps cleanly.
      if (ctx.normal && ctx.a01n) {
        const an = ctx.a01n;
        const anIdx = (wrapPx(ay, an.height) * an.width + wrapPx(ax, an.width)) * 4;
        let bnR: number | null = null;
        let bnG = 0;
        if (ctx.b01n) {
          const bn = ctx.b01n;
          const bnIdx = (wrapPx(y, bn.height) * bn.width + wrapPx(x, bn.width)) * 4;
          bnR = bn.data[bnIdx + 0];
          bnG = bn.data[bnIdx + 1];
        }
        const [ox, oy] = composeEyeNormalOffset(
          an.data[anIdx + 0],
          an.data[anIdx + 1],
          bnR,
          bnG,
          iris ? iris.a : 0,
          ctx.b01.data[bIdx + 3] / 255,
          ctx.params,
        );
        // Encode the tangent offset so chr-cel's standard normal path
        // (sample*2-1, xnormalScale=params.scale) recovers (ox,oy); blue = 1
        // (z=1) makes the TBN multiply reduce to N_geo + ox*T + oy*B.
        const s = ctx.params.scale;
        ctx.normal[oIdx + 0] = ((ox / s) * 0.5 + 0.5) * 255;
        ctx.normal[oIdx + 1] = ((oy / s) * 0.5 + 0.5) * 255;
        ctx.normal[oIdx + 2] = 255;
        ctx.normal[oIdx + 3] = 255;
      }
    }
  }
}

/**
 * The eye-overlay tangent-space normal composite, RE'd from woodmon's eye
 * `_fp.shad` (lines 94-111). Returns the summed tangent-plane offset (ox, oy)
 * that chr-cel adds to the geometric normal:
 *
 *   w_body = max(0, 1 - p01A*sIris - b01A*sB01) * kBody
 *   w_eye  = (b01A * sB01) * kEye
 *   offset = w_body*(a01n.xy - 0.5) + w_eye*(b01n.xy - 0.5)
 *
 * The body term fades out exactly where the iris/sclera overlay covers (the
 * same coverage the color composite uses); the eye term rides the sclera
 * coverage. `a01n*`/`b01n*` are 0-255; `p01A`/`b01A` are 0-1. `b01nR === null`
 * (mask-shape eyes with no eye normal) drops the eye term. Pure + exported for
 * unit tests.
 */
export function composeEyeNormalOffset(
  a01nR: number,
  a01nG: number,
  b01nR: number | null,
  b01nG: number,
  p01A: number,
  b01A: number,
  p: { sIris: number; sB01: number; kBody: number; kEye: number },
): [number, number] {
  const covIris = p01A * p.sIris;
  const covB01 = b01A * p.sB01;
  const wBody = Math.max(0, 1 - covIris - covB01) * p.kBody;
  let ox = wBody * (a01nR / 255 - 0.5);
  let oy = wBody * (a01nG / 255 - 0.5);
  if (b01nR !== null) {
    const wEye = covB01 * p.kEye;
    ox += wEye * (b01nR / 255 - 0.5);
    oy += wEye * (b01nG / 255 - 0.5);
  }
  return [ox, oy];
}

/** An iris sample: RGB in 0-255, alpha normalized to 0-1. */
export interface EyePixel {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * Composite one eye pixel per the in-game shader's color block.
 *
 * With an iris (3-layer eyes): iris (p01) over body (a01), then sclera (b01)
 * over the iris+body result. The sclera's alpha is 0 at the artist-drawn
 * iris hole, so the iris naturally shines through - no explicit clip.
 *
 * Mask-shape eyes pass `iris = null`; step 1 collapses to a01, leaving
 * `lerp(a01, b01, bA)` - DXBC-confirmed on skullgreymon's eye `_fp.shad`,
 * which paints b01's dark socket where its alpha is high.
 *
 * RGB args are 0-255; `bA` and `iris.a` are normalized 0-1. Pure +
 * exported for unit tests.
 */
export function compositeEyePixel(
  aR: number,
  aG: number,
  aB: number,
  bR: number,
  bG: number,
  bB: number,
  bA: number,
  iris: EyePixel | null,
): [number, number, number] {
  let s1R = aR;
  let s1G = aG;
  let s1B = aB;
  if (iris) {
    s1R = aR * (1 - iris.a) + iris.r * iris.a;
    s1G = aG * (1 - iris.a) + iris.g * iris.a;
    s1B = aB * (1 - iris.a) + iris.b * iris.a;
  }
  return [s1R * (1 - bA) + bR * bA, s1G * (1 - bA) + bG * bA, s1B * (1 - bA) + bB * bA];
}

function wrapPx(value: number, max: number): number {
  // Mod-wrap into [0, max). Equivalent to GL's REPEAT wrap mode at sample
  // time, and matches `compose_eye_overlay_texture`'s `u % 1.0` per-vertex
  // wrap in the Python composer. Handles negative values too.
  const wrapped = value % max;
  return wrapped < 0 ? wrapped + max : wrapped;
}

/**
 * Which UV channel the composed canvas must be sampled through. The
 * rasterizer indexes the canvas by `uv3Attr` - a real UV3 (TEXCOORD_2,
 * three's `channel` 2) when the mesh has one, else the UV2 fallback
 * (TEXCOORD_1, `channel` 1). The composed map MUST bind to that same
 * channel; the original base map's channel is irrelevant (and wrong on
 * chrs whose eye mesh bound `a01` at UV1 as its base color - skullgreymon,
 * octomon - vs guilmon, which happened to bind `b01` at UV3 already).
 */
export function eyeOverlayUVChannel(meshes: THREE.Mesh[]): 1 | 2 {
  for (const mesh of meshes) {
    if (getUVAttribute(mesh.geometry as THREE.BufferGeometry, 2)) return 2;
  }
  return 1;
}

/**
 * Replace `mat.map` with a CanvasTexture wrapping `canvas`. Mirrors the
 * sampler config the original base map was using so the existing
 * `EyeOverlayScrollEffect` keeps working with `tex.offset.y`. `channel` is
 * the UV set the canvas is indexed by (see `eyeOverlayUVChannel`).
 */
function applyComposedMap(mat: THREE.Material, canvas: HTMLCanvasElement, channel: 1 | 2): void {
  const m = mat as THREE.MeshStandardMaterial;
  const old = m.map;
  const tex = new THREE.CanvasTexture(canvas);
  // glTF convention: UV V=0 is top of image; GLTFLoader sets flipY=false
  // on its textures. Match it so UV-shift offsets line up.
  tex.flipY = false;
  tex.colorSpace = old?.colorSpace ?? THREE.SRGBColorSpace;
  tex.wrapS = old?.wrapS ?? THREE.RepeatWrapping;
  tex.wrapT = old?.wrapT ?? THREE.RepeatWrapping;
  // Trilinear sampling with auto-mipmaps - matches GLTFLoader's default
  // filtering for glTF base-color textures, so the eye-overlay panel
  // distance-softens the same way the rest of the body diffuse does.
  // (Earlier we forced `LinearFilter` + `generateMipmaps=false` to dodge
  // a hypothetical mipmap-silent-fail trap while hunting the all-black
  // bug; that turned out to be a wrong guess - the real bug was the
  // `tex.channel` mismatch below.)
  tex.minFilter = old?.minFilter ?? THREE.LinearMipmapLinearFilter;
  tex.magFilter = old?.magFilter ?? THREE.LinearFilter;
  tex.generateMipmaps = old?.generateMipmaps ?? true;
  // Critical: sample the composed canvas through the UV set it was indexed
  // by (see `eyeOverlayUVChannel`), NOT the original base map's channel.
  // The canvas is built in b01-space addressed by UV3 (channel 2) - or the
  // UV2 fallback (channel 1) on 2-UV mask meshes. A fresh CanvasTexture
  // defaults to channel 0 (UV1); on chrs whose eye mesh bound `a01` at UV1
  // as its base color (skullgreymon, octomon) the old channel is 0, so
  // sampling there lands nowhere near the composite and the eyes vanish.
  tex.channel = channel;
  // Keep the canonical stem on the new texture so downstream effects /
  // debug tooling can still identify it as the eye-overlay base map.
  if (old?.image && typeof old.image === 'object' && 'name' in old.image) {
    (tex.image as { name?: unknown }).name = (old.image as { name?: unknown }).name;
  }
  tex.needsUpdate = true;
  m.map = tex;
  m.needsUpdate = true;
}

/**
 * Bind the composed eye-overlay NORMAL map. Mirrors `applyComposedMap`'s
 * sampler config but tags the texture LINEAR (normal data, never sRGB) and on
 * the same UV channel as the color composite, so chr-cel - which samples the
 * normal map at the diffuse's `vChrUv` - hits the matching UV3 pixel. The bake
 * encoded the tangent offset against `scale`, so `normalScale = scale` makes
 * chr-cel's standard `sample*2-1 -> xnormalScale -> TBN` path reproduce the
 * disassembled `N_geo + ox*T + oy*B` formula verbatim (blue=1 => tangent z=1).
 * `hasNormalMap` then lights up automatically (the eye-overlay meshes carry
 * TANGENT), so no shader change is needed.
 */
function applyComposedNormal(
  mat: THREE.Material,
  canvas: HTMLCanvasElement,
  channel: 1 | 2,
  scale: number,
): void {
  const m = mat as THREE.MeshStandardMaterial;
  const ref = m.map; // color composite already bound - mirror its sampler config
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace; // tangent-space data, not color
  tex.wrapS = ref?.wrapS ?? THREE.RepeatWrapping;
  tex.wrapT = ref?.wrapT ?? THREE.RepeatWrapping;
  tex.minFilter = ref?.minFilter ?? THREE.LinearMipmapLinearFilter;
  tex.magFilter = ref?.magFilter ?? THREE.LinearFilter;
  tex.generateMipmaps = ref?.generateMipmaps ?? true;
  tex.channel = channel;
  tex.needsUpdate = true;
  m.normalMap = tex;
  m.normalScale = new THREE.Vector2(scale, scale);
  m.needsUpdate = true;
}
