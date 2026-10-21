// Shared texture-byte decoding for the load-time bakes/composers.
//
// The canonical PNG -> ImageBitmap -> drawImage(canvas2D) -> getImageData
// pipeline is LOSSY for any texel whose alpha is < 255: canvas2D stores
// pixels premultiplied, so getImageData has to un-premultiply
// (`RGB_out = round(premult_RGB * 255 / alpha)`), and browsers round that
// division differently. At alpha=0 the RGB is destroyed outright; at partial
// alpha it comes back with browser-divergent noise. That is fatal for atlases
// that pack DATA (metalness/roughness, normal maps, eye-overlay padding) into
// RGB while carrying a non-opaque alpha channel - the data reads back
// scrambled, and differently per browser.
//
// `decodeUnpremultiplied` sidesteps the round-trip by decoding the PNG bytes
// straight from the GLB buffer (`pngDecode`), giving byte-exact,
// browser-invariant channels. It falls back to the lossy canvas path only for
// PNG variants `decodePng` doesn't handle.

import type * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { decodePng } from '../modelViewer/pngDecode';
import { entryFor } from '../../../model-cache';

export interface PixelData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export async function resolveTextureByIndex(
  gltf: GLTF,
  idx: number,
): Promise<THREE.Texture | null> {
  try {
    const tex = (await gltf.parser.getDependency('texture', idx)) as THREE.Texture;
    return tex ?? null;
  } catch {
    return null;
  }
}

/**
 * Decode the PNG bytes backing a glTF texture via our manual PNG parser (see
 * `pngDecode.ts`). Bypasses the canvas2D drawImage -> getImageData round-trip
 * whose un-premultiply mangles RGB on any sub-255-alpha texel (zeroed at
 * alpha=0; browser-divergent noise at partial alpha).
 *
 * Falls back to GLTFLoader's decoded `texture.image` (still canvas2D-routed and
 * thus lossy) when the manual decode can't run - non-PNG, non-RGBA, or
 * buffer-view missing.
 */
export async function decodeUnpremultiplied(gltf: GLTF, texIdx: number): Promise<PixelData | null> {
  const texMeta = gltf.parser.json.textures?.[texIdx] as { source?: number } | undefined;
  const sourceIdx = texMeta?.source;
  const imageJson =
    sourceIdx !== undefined
      ? (gltf.parser.json.images?.[sourceIdx] as
          | { bufferView?: number; mimeType?: string }
          | undefined)
      : undefined;
  const bvIdx = imageJson?.bufferView;
  if (bvIdx !== undefined) {
    try {
      // Local patch (provenance.json): reuse pixels decoded for the same GLB earlier this session.
      const cache = entryFor(gltf.parser)?.decoded;
      const hit = cache?.get(bvIdx);
      if (hit) return hit;
      const buf = (await gltf.parser.getDependency('bufferView', bvIdx)) as ArrayBuffer;
      const decoded = await decodePng(buf);
      if (decoded) {
        const pixels = { width: decoded.width, height: decoded.height, data: decoded.pixels };
        cache?.set(bvIdx, pixels);
        return pixels;
      }
    } catch {
      // Fall through to GLTFLoader's already-decoded image.
    }
  }
  // Fallback path: route through GLTFLoader's already-decoded
  // ImageBitmap -> canvas2D -> getImageData. Lossy at sub-255-alpha pixels but
  // covers PNG variants `decodePng` doesn't handle (paletted, 16-bit,
  // interlaced) and non-PNG mimes.
  const tex = await resolveTextureByIndex(gltf, texIdx);
  if (!tex) return null;
  const canvas = textureToCanvas(tex);
  if (!canvas) return null;
  return readPixelData(canvas);
}

/**
 * Render a loaded `THREE.Texture` into a 2D canvas so we can read its pixel
 * data. `tex.image` must be an `ImageBitmap`/`HTMLImageElement`/
 * `HTMLCanvasElement` - GLTFLoader resolves images before this runs.
 */
function textureToCanvas(tex: THREE.Texture): HTMLCanvasElement | null {
  const img = tex.image as CanvasImageSource & { width?: number; height?: number };
  if (!img) return null;
  const w = img.width;
  const h = img.height;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  return canvas;
}

function readPixelData(canvas: HTMLCanvasElement): PixelData | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: img.data };
}
