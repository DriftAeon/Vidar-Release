// The model's diffuse atlas surrounds each UV island with a few texels of
// unrelated padding, and the mirrored face halves both end on an island edge.
// GPU mip generation averages that padding into the edge texels, which shows
// as a dark line down the character's midline at sidebar zoom. Extending the
// island colors outward before upload keeps every mip level on-island.
import * as T from "three";
import type { CachedPixels } from "./model-cache";

/** Copies each uncovered pixel from its nearest covered pixel, wrapping at the
 *  edges like RepeatWrapping. Jump flooding: O(pixels * log(radius)). */
export function dilateCoverage(pixels: Uint8ClampedArray, coverage: Uint8Array, width: number, height: number, radius: number): Uint8ClampedArray<ArrayBuffer> {
  const count = width * height;
  if (pixels.length !== count * 4 || coverage.length !== count) throw new Error("Atlas padding size mismatch.");
  let seed = new Int32Array(count);
  let next = new Int32Array(count);
  for (let i = 0; i < count; i++) seed[i] = coverage[i] ? i : -1;
  const halfWidth = width / 2, halfHeight = height / 2;
  const distanceTo = (index: number, x: number, y: number) => {
    let sx = Math.abs(index % width - x);
    let sy = Math.abs(Math.floor(index / width) - y);
    if (sx > halfWidth) sx = width - sx;
    if (sy > halfHeight) sy = height - sy;
    return sx * sx + sy * sy;
  };
  let step = 1;
  while (step * 2 < radius) step *= 2;
  for (; step >= 1; step >>= 1) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let best = seed[i];
        let bestDistance = best < 0 ? Infinity : distanceTo(best, x, y);
        for (let dy = -step; dy <= step; dy += step) {
          const ny = (y + dy + height) % height;
          for (let dx = -step; dx <= step; dx += step) {
            const candidate = seed[ny * width + (x + dx + width) % width];
            if (candidate < 0 || candidate === best) continue;
            const distance = distanceTo(candidate, x, y);
            if (distance < bestDistance) { best = candidate; bestDistance = distance; }
          }
        }
        next[i] = best;
      }
    }
    [seed, next] = [next, seed];
  }
  const output = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < count; i++) {
    const source = (seed[i] < 0 ? i : seed[i]) * 4;
    output[i * 4] = pixels[source];
    output[i * 4 + 1] = pixels[source + 1];
    output[i * 4 + 2] = pixels[source + 2];
    output[i * 4 + 3] = pixels[source + 3];
  }
  return output;
}

const PADDING_RADIUS = 64;

/** Returns a copy of `source` whose off-island texels carry the nearest island
 *  color, judged by the UV triangles of `meshes`. Sampler settings are kept. */
export function padAtlasTexture(source: T.Texture, meshes: T.Mesh[], memo?: { store: Map<number, CachedPixels>; key: number }): T.CanvasTexture {
  const image = source.image as ImageBitmap;
  const { width, height } = image;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not prepare the character atlas.");
  const hit = memo?.store.get(memo.key);
  if (hit && hit.width === width && hit.height === height) {
    context.putImageData(new ImageData(hit.data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  } else {
    const pixels = dilateAtlas(source, meshes, image, context);
    context.putImageData(new ImageData(pixels, width, height), 0, 0);
    memo?.store.set(memo.key, { width, height, data: pixels });
  }
  return paddedTexture(source, canvas);
}

function dilateAtlas(source: T.Texture, meshes: T.Mesh[], image: ImageBitmap, context: CanvasRenderingContext2D): Uint8ClampedArray<ArrayBuffer> {
  const { width, height } = image;
  const mask = document.createElement("canvas");
  mask.width = width;
  mask.height = height;
  const maskContext = mask.getContext("2d", { willReadFrequently: true });
  if (!maskContext) throw new Error("Could not prepare the character atlas.");
  context.drawImage(image, 0, 0);
  maskContext.fillStyle = "#fff";
  for (const mesh of meshes) {
    const uv = mesh.geometry.getAttribute(source.channel ? `uv${source.channel}` : "uv") as T.BufferAttribute | undefined;
    if (!uv) continue;
    const index = mesh.geometry.index;
    const vertexCount = index ? index.count : uv.count;
    const corner = (i: number) => {
      const vertex = index ? index.getX(i) : i;
      return [(uv.getX(vertex) * source.repeat.x + source.offset.x) * width, (uv.getY(vertex) * source.repeat.y + source.offset.y) * height];
    };
    for (let t = 0; t + 2 < vertexCount; t += 3) {
      const [a, b, c] = [corner(t), corner(t + 1), corner(t + 2)];
      // UVs may run past [0, 1] under RepeatWrapping; cover the wrapped copies.
      for (let oy = -height; oy <= height; oy += height) {
        for (let ox = -width; ox <= width; ox += width) {
          maskContext.beginPath();
          maskContext.moveTo(a[0] + ox, a[1] + oy);
          maskContext.lineTo(b[0] + ox, b[1] + oy);
          maskContext.lineTo(c[0] + ox, c[1] + oy);
          maskContext.closePath();
          maskContext.fill();
        }
      }
    }
  }
  const maskData = maskContext.getImageData(0, 0, width, height).data;
  const coverage = new Uint8Array(width * height);
  for (let i = 0; i < coverage.length; i++) coverage[i] = maskData[i * 4 + 3] > 0 ? 1 : 0;
  return dilateCoverage(context.getImageData(0, 0, width, height).data, coverage, width, height, PADDING_RADIUS);
}

function paddedTexture(source: T.Texture, canvas: HTMLCanvasElement): T.CanvasTexture {
  const texture = new T.CanvasTexture(canvas);
  texture.name = `${source.name}:padded`;
  texture.colorSpace = source.colorSpace;
  texture.flipY = source.flipY;
  texture.wrapS = source.wrapS;
  texture.wrapT = source.wrapT;
  texture.minFilter = source.minFilter;
  texture.magFilter = source.magFilter;
  texture.anisotropy = source.anisotropy;
  texture.channel = source.channel;
  texture.offset.copy(source.offset);
  texture.repeat.copy(source.repeat);
  texture.needsUpdate = true;
  return texture;
}
