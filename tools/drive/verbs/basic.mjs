// eval, invoke, click, text, shot: the page-level verbs. Each handler gets the drive context
// (vidar-drive.mjs) and returns the value to print.
import fs from "node:fs";
import path from "node:path";
import {
  parseShotOpts, captureParams, clipKey, hashBytes, checkUnchanged, recordShot, explorerRun,
  MASK_ON_JS, MASK_OFF_JS,
} from "../shot-opts.mjs";

export const evalVerb = ({ a1, evalJs }) => evalJs(a1);

export const invoke = ({ a1, a2, evalJs, q }) =>
  evalJs(`window.__TAURI_INTERNALS__.invoke(${q(a1)}, ${a2 ?? "{}"})`);

export const click = ({ a1, evalJs, q }) =>
  evalJs(`(() => { const el = document.querySelector(${q(a1)}); if (!el) throw new Error("no match: " + ${q(a1)}); el.click(); return el.tagName + (el.className ? "." + String(el.className).split(" ").join(".") : ""); })()`);

export const text = ({ a1, evalJs, q }) =>
  evalJs(`[...document.querySelectorAll(${q(a1)})].map((e) => e.textContent.trim())`);

// Page-side: element rect in document coordinates for a ref (lane A's byRef) or a selector.
const clipRectJs = (target, q) => `(() => {
  const t = ${q(target)};
  const st = globalThis.__vidarExplorer;
  const isRef = /^e\\d+$/.test(t);
  let el = null;
  if (isRef) {
    el = st?.byRef?.get(t)?.deref() ?? null;
    if (!el || !el.isConnected) return { stale: t };
  } else el = document.querySelector(t);
  if (!el) throw new Error("no match: " + t);
  const r = el.getBoundingClientRect();
  return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
})()`;
const viewportJs = "({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight })";

export async function shot({ a1, flags = {}, send, withTimeout, EVAL_MS, evalJs, q }) {
  const opts = parseShotOpts(flags);
  const out = opts.out ?? (a1 && !String(a1).startsWith("--") ? a1 : null);
  if (!out) throw new Error("usage: shot <path> | shot [--clip <ref|selector>] [--scale 0.1-1] [--jpeg 1-100] --out <path>");
  const plain = !opts.clip && opts.scale === null && !opts.jpeg;
  let rect = null, viewport = null;
  if (opts.clip) {
    rect = await evalJs(clipRectJs(opts.clip, q));
    if (rect?.stale) {
      console.error(`stale ref: ${rect.stale} (take a fresh snapshot)`);
      process.exit(2);
    }
  }
  else if (opts.scale !== null) viewport = await evalJs(viewportJs);
  const run = explorerRun();
  const masked = !plain && run; // hash-skip only with a run folder; the mask only matters then
  if (masked) await evalJs(MASK_ON_JS);
  let r;
  try {
    r = await withTimeout(send("Page.captureScreenshot", captureParams(opts, rect, viewport)), EVAL_MS, "Page.captureScreenshot");
  } finally {
    if (masked) await evalJs(MASK_OFF_JS).catch(() => {});
  }
  const bytes = Buffer.from(r.data, "base64");
  if (masked) {
    const key = clipKey(opts), hash = hashBytes(bytes);
    const same = checkUnchanged(run, key, hash);
    if (same) return same;
    recordShot(run, key, hash, out);
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, bytes);
  return plain ? `wrote ${out}` : { path: out, bytes: bytes.length };
}
