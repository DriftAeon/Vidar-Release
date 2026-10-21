// Minimal PNG -> raw RGBA decoder.
//
// Why we have this when the browser already decodes PNGs: the canonical
// PNG -> ImageBitmap -> drawImage(canvas2D) -> getImageData pipeline is LOSSY
// for pixels with alpha=0 and non-zero RGB. The browser's canvas2D
// implementations effectively premultiply alpha at the drawImage step,
// then divide-by-zero during getImageData's un-premultiply pass - leaving
// (0, 0, 0, 0) where the PNG actually authored (R, G, B, 0).
//
// The eye-overlay bake's initial canvas needs to preserve those alpha=0
// RGB values so the rasterizer can leave them as the safety-net
// background color for pixels outside any mesh triangle. The old Python
// compose_eye_overlay_texture used `b01.copy()` which doesn't
// premultiply; this decoder restores that behavior in JS.
//
// Supports the only PNG variants `glb_bundle.py` produces: 8-bit
// truecolor with alpha (color type 6, bit depth 8). Doesn't handle
// paletted, grayscale, 16-bit, or interlaced PNGs - they aren't in
// our pipeline. Bails out for anything else.

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** RGBA bytes, row-major, top-down. Length = width x height x 4. */
  readonly pixels: Uint8ClampedArray;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export async function decodePng(bytes: ArrayBuffer | Uint8Array): Promise<DecodedPng | null> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.length < 8) return null;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return null;
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Uint8Array[] = [];

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length =
      (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    const type = String.fromCharCode(
      buf[offset + 4],
      buf[offset + 5],
      buf[offset + 6],
      buf[offset + 7],
    );
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      if (length !== 13) return null;
      width =
        (buf[dataStart] << 24) |
        (buf[dataStart + 1] << 16) |
        (buf[dataStart + 2] << 8) |
        buf[dataStart + 3];
      height =
        (buf[dataStart + 4] << 24) |
        (buf[dataStart + 5] << 16) |
        (buf[dataStart + 6] << 8) |
        buf[dataStart + 7];
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
      // Truecolor + alpha (RGBA), 8-bit, non-interlaced is all our bundler
      // emits. Other combos: defer to the canvas2D path (lossy at alpha=0).
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) return null;
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4; // skip data + 4-byte CRC
  }

  if (!width || !height || idatChunks.length === 0) return null;

  const compressed = concat(idatChunks);
  const inflated = await inflate(compressed);
  if (!inflated) return null;

  // Unfilter scanlines. For RGBA 8-bit, bpp = 4. Each row is prefixed by
  // a 1-byte filter type, followed by width*4 raw bytes.
  const bpp = 4;
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (inflated.length < expected) return null;

  const pixels = new Uint8ClampedArray(width * height * 4);
  const prevRow = new Uint8Array(stride);
  const curRow = new Uint8Array(stride);
  let srcOff = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[srcOff++];
    for (let x = 0; x < stride; x++) {
      const raw = inflated[srcOff++];
      const left = x >= bpp ? curRow[x - bpp] : 0;
      const up = prevRow[x];
      const upLeft = x >= bpp ? prevRow[x - bpp] : 0;
      let value: number;
      switch (filter) {
        case 0: // None
          value = raw;
          break;
        case 1: // Sub
          value = (raw + left) & 0xff;
          break;
        case 2: // Up
          value = (raw + up) & 0xff;
          break;
        case 3: // Average
          value = (raw + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          // Paeth
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          value = (raw + predictor) & 0xff;
          break;
        }
        default:
          return null;
      }
      curRow[x] = value;
    }
    pixels.set(curRow, y * stride);
    prevRow.set(curRow);
  }

  return { width, height, pixels };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function inflate(zlibBytes: Uint8Array): Promise<Uint8Array | null> {
  // DecompressionStream('deflate') consumes zlib-wrapped DEFLATE - the
  // exact format PNG's IDAT uses.
  try {
    const stream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(zlibBytes);
          controller.close();
        },
      }),
    ).body!.pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}
