// A cel ramp is one-dimensional lighting data (style-toon.ts passes a synthetic one).
// Smooth it once at load time, preserving its colors and avoiding extra texture reads per frame.
export function softenCelRamp(row: Uint8ClampedArray): Uint8Array<ArrayBuffer> {
  if (row.length === 0 || row.length % 4 !== 0) throw new Error("Invalid cel ramp.");
  const width = row.length / 4;
  const sigma = Math.max(0.5, width * 0.06);
  const radius = Math.ceil(sigma * 3);
  const weights = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const output = new Uint8Array(row.length);
  for (let x = 0; x < width; x++) {
    const channels = [0, 0, 0, 0];
    for (let i = 0; i < weights.length; i++) {
      const source = Math.max(0, Math.min(width - 1, x + i - radius)) * 4;
      for (let c = 0; c < 4; c++) channels[c] += row[source + c] * weights[i];
    }
    for (let c = 0; c < 4; c++) output[x * 4 + c] = Math.round(channels[c] / totalWeight);
  }
  return output;
}
