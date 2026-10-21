// Display renderer: turns one bridge\display file into a painted element inside one host.
// svg/html go through the offline preview renderer (panels/preview.ts), png is a plain <img>
// from a blob URL. Relay and Document paint display files through it (the Display tab that
// first held it folded into them, 2026-10-16). Every renderer owns its read generation, its
// on-screen file (and that file's object URL) and its staged frame; nothing here is
// module-level, so one host never cancels another's staging. It also owns the display IPC
// shapes that ipc.ts types its commands with.

import { invoke } from "../ipc";
import { renderPreview } from "./preview";
export type { DecisionView } from "./display-decision";

/** One listed display file (bridge.rs `DisplayEntry`). */
export interface DisplayEntry {
  path: string;
  kind: string;
  mtime_ms: number;
  /** catalog group for docs outside bridge\display (Inbox, Run · <slug>) */
  group?: string;
}
/** `list_display` and the `display-update` event (bridge/display.rs `DisplayUpdate`). */
export interface DisplayUpdate {
  files: DisplayEntry[];
  /** .md/.txt in the same folder; not forwarded to the Documents menu */
  docs: DisplayEntry[];
  newest: string | null;
}
export interface DisplayFile {
  kind: string;
  content: string;
  /** sha256 of the file bytes as read — what a decision binds to */
  sha256: string;
}
export interface DisplayPng {
  sha256: string;
  base64: string;
}

/** What is on screen: the read the source toggle and a verdict are bound to. */
export interface Painted {
  gen: number; path: string; kind: "png" | "svg" | "html"; sha256: string; mtimeMs: number; content: string | null;
  url: string | null; el: HTMLElement; note: string; fellBack: boolean;
}
export interface DisplayRenderer {
  /** null = superseded by a newer show() (or a clear()) before it painted */
  show(f: DisplayEntry): Promise<Painted | { error: string } | null>;
  clear(): void; current(): Painted | null; gen(): number;
  showingSource(): boolean; setSource(on: boolean): void;
}

const MAX_PIXELS = 32_000_000; // decoded; same bound as the tray's image blocks

export function sourcePre(t: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "display-source";
  pre.textContent = t; // outside the frame, as text
  return pre;
}

/** width/height straight out of the PNG header: 8-byte signature, then the IHDR chunk's
 *  length+type, so the two big-endian u32s sit at 16 and 20. null = not a PNG header. */
function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

/* A swap never blanks the host: the old render stays up until the new file is ready to
   paint (png decoded off-DOM, an HTML frame loaded behind it), and only then replaces it. */
export function createDisplayRenderer(host: HTMLElement, opts: { onNote?(note: string): void } = {}): DisplayRenderer {
  /** guards success AND failure of an async read against a newer show() */
  let showGen = 0;
  let current: Painted | null = null;
  let showing = false;
  /** aborts the HTML frame loading behind the render on screen (a newer show() owns the host) */
  let cancelStaging: (() => void) | null = null;
  const note = (n: string) => opts.onNote?.(n);

  function releaseCurrent() {
    if (current?.url) URL.revokeObjectURL(current.url);
    current = null;
    showing = false;
  }

  /** Appends `frame` hidden behind the render on screen (an unloaded frame paints its
   *  own #fff background for a frame or more). Resolves true on load or after 1500 ms,
   *  false when a newer show() cancels it; the caller swaps or removes the frame. */
  function stageFrame(frame: HTMLIFrameElement): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        frame.removeEventListener("load", onLoad);
        if (cancelStaging === cancel) cancelStaging = null;
        resolve(ok);
      };
      const onLoad = () => done(true), cancel = () => done(false), timer = setTimeout(onLoad, 1500);
      frame.addEventListener("load", onLoad);
      cancelStaging = cancel;
      frame.classList.add("display-staging");
      host.appendChild(frame);
    });
  }

  /** nothing readable is on screen any more; a stale failure must not replace a newer file */
  function fail(gen: number, error: string): { error: string } | null {
    if (gen !== showGen) return null;
    releaseCurrent();
    return { error };
  }

  async function show(f: DisplayEntry): Promise<Painted | { error: string } | null> {
    const gen = ++showGen;
    cancelStaging?.();
    try {
      if (f.kind === "png") {
        const png = await invoke("read_display_png", { path: f.path });
        if (gen !== showGen) return null;
        const bytes = Uint8Array.from(atob(png.base64), (c) => c.charCodeAt(0));
        // bound it from the header, before anything decodes: decoding a 32 MP bitmap to
        // find out it is 32 MP is what the bound exists to avoid
        const size = pngSize(bytes);
        if (size && size.w * size.h > MAX_PIXELS) return fail(gen, `image too large to show (${size.w}×${size.h})`);
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        const img = document.createElement("img");
        img.className = "display-render display-png";
        img.decoding = "async";
        img.src = url;
        // decoded off-DOM: the old render stays up until this resolves, so there is no blank
        try {
          await img.decode();
        } catch {
          URL.revokeObjectURL(url);
          return fail(gen, "image failed to decode");
        }
        if (gen !== showGen) { URL.revokeObjectURL(url); return null; }
        if (img.naturalWidth * img.naturalHeight > MAX_PIXELS) { // no readable header
          URL.revokeObjectURL(url);
          return fail(gen, `image too large to show (${img.naturalWidth}×${img.naturalHeight})`);
        }
        releaseCurrent(); // only now: it revokes the url of what was on screen
        const shown = `${img.naturalWidth}×${img.naturalHeight} png`;
        current = { gen, path: f.path, kind: "png", sha256: png.sha256, mtimeMs: f.mtime_ms, content: null, url, el: img, note: shown, fellBack: false };
        host.replaceChildren(img);
        note(shown);
        return current;
      }
      const file = await invoke("read_display_file", { path: f.path });
      if (gen !== showGen) return null;
      const kind = file.kind === "svg" ? "svg" : "html";
      const r = renderPreview(kind, file.content);
      if (r.el instanceof HTMLImageElement) {
        r.el.addEventListener("error", () => { if (gen === showGen) note("image failed to decode"); });
      }
      if (r.el instanceof HTMLIFrameElement) {
        // loads behind the render on screen; replaceChildren(frame) would detach and reload it
        if (!(await stageFrame(r.el)) || gen !== showGen || !r.el.isConnected) { r.el.remove(); return null; }
        for (const c of Array.from(host.childNodes)) if (c !== r.el) c.remove();
        r.el.classList.remove("display-staging");
      } else {
        host.replaceChildren(r.el);
      }
      releaseCurrent();
      // stripped scripts/handlers are not reported: nothing the user can act on (2026-10-04)
      const shown = r.fellBack ? `Source shown: ${r.fellBack.reason}` : "";
      current = { gen, path: f.path, kind, sha256: file.sha256, mtimeMs: f.mtime_ms, content: file.content, url: null, el: r.el, note: shown, fellBack: !!r.fellBack };
      showing = !!r.fellBack;
      note(shown);
      return current;
    } catch (e) {
      return fail(gen, String(e));
    }
  }

  /** Drops the render and invalidates pending reads; the host is left empty. */
  function clear() {
    showGen++;
    cancelStaging?.();
    releaseCurrent();
    host.replaceChildren();
  }

  /** Source or rendered view of the file on screen (no-op for a png). An iframe is hidden,
   *  never detached: a re-attached frame reloads and is blank until it loads again. */
  function setSource(on: boolean) {
    if (!current || current.content === null) return;
    showing = on;
    const r = current.el;
    if (r instanceof HTMLIFrameElement && r.isConnected) {
      host.querySelector(":scope > .display-source")?.remove();
      if (showing) host.appendChild(sourcePre(current.content));
      r.classList.toggle("hidden", showing);
    } else {
      host.replaceChildren(showing ? sourcePre(current.content) : r);
    }
  }

  return { show, clear, current: () => current, gen: () => showGen, showingSource: () => showing, setSource };
}
