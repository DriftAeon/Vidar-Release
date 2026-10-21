/* Tiny audio cues for the Listen button:
   two short sine blips for "wake" (a wake word fired) and "delivered" (an utterance
   reached the focused tab), a single lower blip for "busy" (a wake arrived while the
   previous utterance was still being handled). No files, no Kokoro round trip —
   plain WebAudio oscillators.

   Browsers refuse to run an AudioContext until a user gesture; primeChime() is called
   from the Listen button's own click handler so the context is always warm by the time
   a chime is needed (the sidecar's first "wake" line arrives well after that click). */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  else if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Call from a user-gesture handler (the button's click) before any chime is needed. */
export function primeChime() {
  ensureCtx();
}

// Soft tap, not a beep (880/1320 Hz sines at gain 0.2 were
// piercing). Low gain, slow attack, long exponential tail; frequencies stay under 700 Hz.
const PEAK = 0.07;

function blip(c: AudioContext, freq: number, atSeconds: number, durSeconds: number) {
  const t0 = c.currentTime + atSeconds;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(PEAK, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durSeconds);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + durSeconds + 0.02);
}

export type ChimeKind = "wake" | "delivered" | "busy";

export function playChime(kind: ChimeKind) {
  const c = ensureCtx();
  // Variants audition as WAVs via tools\voice\chime-preview.mjs (tap-wake / soft-busy / soft-wake).
  if (kind === "busy") {
    blip(c, 330, 0, 0.16);
    return;
  }
  if (kind === "wake") {
    blip(c, 523, 0, 0.22);
    return;
  }
  // "delivered": gentle two-note rise (440 -> 660 Hz, 180 ms each), distinct from the wake tap.
  blip(c, 440, 0, 0.18);
  blip(c, 660, 0.14, 0.18);
}
