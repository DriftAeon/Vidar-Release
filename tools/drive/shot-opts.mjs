// Pure helpers for `shot` (clip, scale, jpeg, hash-skip) and `look` (cap, image mime). No CDP, no
// spawning: tests drive these directly. State lives in $VIDAR_EXPLORER_RUN/state/*.json.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RAW_FLAGS = ["clip", "scale", "jpeg", "out"];

// Flags → validated options. Throws on a bad value; no flags → plain full-page png.
export function parseShotOpts(flags = {}) {
  const o = { clip: null, scale: null, jpeg: null, out: null };
  for (const k of RAW_FLAGS) if (flags[k] === true) throw new Error(`shot: --${k} needs a value`);
  if (flags.clip !== undefined) o.clip = String(flags.clip);
  if (flags.out !== undefined) o.out = String(flags.out);
  if (flags.scale !== undefined) {
    const s = Number(flags.scale);
    if (!(s >= 0.1 && s <= 1)) throw new Error("shot: --scale must be 0.1-1");
    o.scale = s;
  }
  if (flags.jpeg !== undefined) {
    const j = Number(flags.jpeg);
    if (!Number.isInteger(j) || j < 1 || j > 100) throw new Error("shot: --jpeg must be an integer 1-100");
    o.jpeg = j;
  }
  return o;
}

// Page.captureScreenshot params. rect is {x,y,width,height} in CSS px (document coordinates), or
// null for the viewport when only --scale is given (viewport = {x,y,width,height} then).
export function captureParams(opts, rect, viewport) {
  const p = { format: opts.jpeg ? "jpeg" : "png" };
  if (opts.jpeg) p.quality = opts.jpeg;
  const r = rect ?? (opts.scale !== null ? viewport : null);
  if (r) {
    if (!(r.width > 0 && r.height > 0)) throw new Error("shot: clip has no area");
    p.clip = { x: r.x, y: r.y, width: r.width, height: r.height, scale: opts.scale ?? 1 };
  }
  return p;
}

export const needsClip = (opts) => opts.clip !== null || opts.scale !== null;

// Stable key for "the same shot": target, scale, format.
export const clipKey = (opts) => `${opts.clip ?? (opts.scale !== null ? "viewport" : "page")}|${opts.scale ?? 1}|${opts.jpeg ?? "png"}`;

export const hashBytes = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Injected while capturing so the caret blink and spinners cannot change the hash.
export const MASK_STYLE_ID = "__vidar-shot-mask";
export const MASK_ON_JS = `(() => { const s = document.createElement("style"); s.id = ${JSON.stringify(MASK_STYLE_ID)}; s.textContent = "*,*::before,*::after{caret-color:transparent !important;animation-play-state:paused !important}"; document.documentElement.appendChild(s); return true; })()`;
export const MASK_OFF_JS = `(() => { document.getElementById(${JSON.stringify(MASK_STYLE_ID)})?.remove(); return true; })()`;

export const explorerRun = (env = process.env) => env.VIDAR_EXPLORER_RUN || null;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
}

const hashFile = (run) => path.join(run, "state", "shot-hashes.json");

// → {unchanged:true, path} when bytes equal the last shot for this key; else null. No run → null.
export function checkUnchanged(run, key, hash) {
  if (!run) return null;
  const prev = readJson(hashFile(run), {})[key];
  return prev && prev.hash === hash && prev.path ? { unchanged: true, path: prev.path } : null;
}

export function recordShot(run, key, hash, outPath) {
  if (!run) return;
  const all = readJson(hashFile(run), {});
  all[key] = { hash, path: outPath };
  writeJson(hashFile(run), all);
}

// look cap: counts per episode in state/looks.json. Returns the new count, or throws the refusal.
export const LOOK_CAP = 5;
export function countLook(run, episode, cap = LOOK_CAP) {
  if (!run) return 0; // no run folder: nothing to count against
  const file = path.join(run, "state", "looks.json");
  const all = readJson(file, {});
  const ep = episode || "default";
  const n = all[ep] ?? 0;
  if (n >= cap) throw new LookCapError(`refused: look cap ${cap} reached`);
  all[ep] = n + 1;
  writeJson(file, all);
  return n + 1;
}
export class LookCapError extends Error {}

export const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

export const LOOK_PROMPT = "Answer the question about this UI screenshot in at most two sentences. Describe what is visible; do not guess intent.";

// The stream-json user message that carries the image and the question to `claude -p`.
export function lookMessage(imageBytes, mime, question) {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mime, data: Buffer.from(imageBytes).toString("base64") } },
        { type: "text", text: `${LOOK_PROMPT}\n\n${question}` },
      ],
    },
  });
}
