// chime-preview.mjs - render the Listen button's chimes (src\chime.ts) to WAV so they
// can be auditioned without a rebuild and swap.
//
//   node tools\voice\chime-preview.mjs [outDir]      (default: %TEMP%\vidar-chimes)
//
// Each variant below mirrors playChime(): a list of blips {freq, at, dur} with the same
// envelope (linear attack to PEAK, exponential decay to silence). Edit VARIANTS to try
// new sounds; the one that wins gets copied into chime.ts by hand. 44.1 kHz mono 16-bit.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RATE = 44100;

const VARIANTS = {
  "old-wake":       { peak: 0.2,  attack: 0.01, blips: [[880, 0, 0.09], [1320, 0.1, 0.09]] },
  "old-busy":       { peak: 0.2,  attack: 0.01, blips: [[440, 0, 0.07]] },
  "soft-wake":      { peak: 0.07, attack: 0.02, blips: [[440, 0, 0.18], [660, 0.14, 0.18]] },
  "soft-busy":      { peak: 0.07, attack: 0.02, blips: [[330, 0, 0.16]] },
  "tap-wake":       { peak: 0.07, attack: 0.02, blips: [[523, 0, 0.22]] },
  "fall-delivered": { peak: 0.07, attack: 0.02, blips: [[660, 0, 0.18], [440, 0.14, 0.22]] },
  "marimba-wake":   { peak: 0.09, attack: 0.005, blips: [[392, 0, 0.35], [587, 0.12, 0.4]] },
};

function render({ peak, attack, blips }) {
  const end = Math.max(...blips.map(([, at, dur]) => at + dur)) + 0.1;
  const n = Math.ceil(end * RATE);
  const out = new Float64Array(n);
  for (const [freq, at, dur] of blips) {
    const s0 = Math.floor(at * RATE);
    const sAtt = Math.floor(attack * RATE);
    const sEnd = Math.floor((at + dur) * RATE);
    for (let i = s0; i < sEnd && i < n; i++) {
      const t = (i - s0) / RATE;
      let g;
      if (i - s0 < sAtt) g = 0.0001 + (peak - 0.0001) * ((i - s0) / sAtt);
      else {
        const k = (i - s0 - sAtt) / (sEnd - s0 - sAtt);
        g = peak * Math.pow(0.0001 / peak, k);
      }
      out[i] += g * Math.sin(2 * Math.PI * freq * t);
    }
  }
  return out;
}

function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const outDir = process.argv[2] ?? join(tmpdir(), "vidar-chimes");
mkdirSync(outDir, { recursive: true });
for (const [name, v] of Object.entries(VARIANTS)) {
  writeFileSync(join(outDir, `${name}.wav`), wav(render(v)));
}
console.log(outDir);
