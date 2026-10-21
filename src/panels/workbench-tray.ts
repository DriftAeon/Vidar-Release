// Workbench Tray: the blocks, their producers (paste, drop, the marquee
// tool's "to tray"), and removal. Paste and tool text are frozen
// content; a dropped file is a FILE block — a live reference whose
// path actions use the original path and never save a copy. Blocks live in
// memory; a path action on a content block saves it once to bridge\clips\.
//
// Split from workbench.ts, which keeps the pane shell and tab switcher and
// hands in what the tray needs from it through `TrayDeps` (mountTray). This
// file never imports workbench.ts.

import { invoke } from "../ipc";
import { moduleName } from "../modules/names";
import { publishBlock, publishEntry, restoreTray, type Outcome, type Restore } from "./workbench-bridge";
import { trayTakesPaste } from "./workbench-paste";
import { releaseName, reserveNames, takeBlockName } from "./workbench-names";
import { MAX_PIXELS, TEXT_EXT, admit } from "./workbench-limits";
import { copyContent, copyPathAction } from "./workbench-actions";
import { iconImg } from "../icon-img";
import { mountAnnotation } from "./workbench-annotate";
import { copyButton, copyPathButton, isBrowserPath, openInBrowserButton } from "./file-actions";

export type Source = "paste" | "drop" | "marquee" | "log crop";
export type { Outcome } from "./workbench-bridge";

interface Block {
  id: number;
  /** spoken name (Alpha, Bravo…) so the block can be referred to out loud */
  name: string;
  /** bumped by removeBlock; every action re-checks it after each await */
  gen: number;
  kind: "text" | "png";
  source: Source;
  at: number;
  /** what the tray holds — the content, or a file's preview */
  previewBytes: number;
  /** file blocks: real size observed when read; display only, never a limit */
  fileBytes?: number;
  text?: string;
  /** the user's saved annotation; persisted in the published entry */
  annotation?: string;
  /** fold state; persisted in the published entry */
  collapsed?: boolean;
  blob?: Blob;
  url?: string;
  /** set at creation for file blocks (so save() never writes); cached after a save otherwise */
  path?: string;
  /** shared in-flight save so repeated clicks don't write twice */
  saving?: Promise<string>;
  el: HTMLElement;
  note: HTMLElement;
}

interface FileMeta {
  path: string;
  name: string;
  kind: "text" | "png";
  fileBytes: number;
  text?: string;
  blob?: Blob;
  truncated?: boolean;
  lossy?: boolean;
}

/** What the tray needs from the pane shell (workbench.ts), injected once by mountTray. */
export interface TrayDeps {
  /** the header note line; `landed` marks the "Added To" confirmation so the shell can clear it on a tab switch */
  note: (msg: string, landed?: boolean) => void;
  /** switches to the Document tab and opens the path there */
  openInDocument: (path: string) => void | Promise<void>;
  /** shows the pane without moving focus or the terminal destination */
  revealWorkbench: () => void;
  /** true while the Tray tab is the active header tab */
  trayActive: () => boolean;
}

let bodyEl: HTMLElement;
let deps: TrayDeps;
const blocks: Block[] = [];
let nextId = 0;
/** drops and other batches run in order; overlapping ones queue behind */
let batchChain: Promise<void> = Promise.resolve();

function note(msg: string) {
  deps.note(msg);
}

/** Binds the tray to its body element and the shell's callbacks, then
 *  rebuilds whatever survived from the last run. */
export function mountTray(body: HTMLElement, d: TrayDeps) {
  bodyEl = body;
  deps = d;
  // Rebuild whatever survived from the last run.
  void restoreTray({ reserveNames, note, blocks, addDroppedFile, addImageBlock, addTextBlock });
}

/* ---- producers ---- */

export function addTextBlock(text: string, source: Source, restore?: Restore): Outcome {
  const bytes = new TextEncoder().encode(text).length;
  const why = admit("text", bytes, blocks.length);
  if (why) return { ok: false, reason: why, transient: true };
  const pre = document.createElement("pre");
  pre.className = "wb-text";
  pre.textContent = text; // text node, never HTML
  buildBlock("text", source, bytes, pre, undefined, restore, text);
  return { ok: true };
}

/** Resolves after decode and the pixel check — a synchronous ok would precede
 *  a decode rejection. The block shows dimmed with "decoding…" meanwhile. */
function addImageBlock(blob: Blob, source: Source, file?: FileMeta, restore?: Restore): Promise<Outcome> {
  const why = admit("png", blob.size, blocks.length);
  if (why) return Promise.resolve({ ok: false, reason: why, transient: true });
  const img = document.createElement("img");
  img.className = "wb-img";
  const url = URL.createObjectURL(blob);
  img.src = url;
  const b = buildBlock("png", source, blob.size, img, file, restore);
  b.blob = blob;
  b.url = url;
  // buildBlock already published the entry before b.blob existed; a
  // path-less image needs its bytes written now that they do (they are the
  // whole reason a restore can bring this block back).
  if (!file?.path) publishBlock(b);
  b.el.classList.add("wb-pending");
  b.note.textContent = "decoding…";
  const gen = b.gen;
  return new Promise<Outcome>((resolve) => {
    img.addEventListener("load", () => {
      if (b.gen !== gen) return resolve({ ok: false, reason: "cancelled" });
      const px = img.naturalWidth * img.naturalHeight;
      if (px > MAX_PIXELS) {
        removeBlock(b);
        return resolve({ ok: false, reason: `image over ${MAX_PIXELS / 1e6} megapixels` });
      }
      b.el.classList.remove("wb-pending");
      setFileNote(b, file, `${img.naturalWidth}×${img.naturalHeight}`);
      resolve({ ok: true });
    });
    img.addEventListener("error", () => {
      if (b.gen === gen) removeBlock(b);
      resolve({ ok: false, reason: "image failed to decode" });
    });
  });
}

/** A live file reference: original path, preview captured now. Path actions
 *  use the path as-is and never save; the preview is never re-saved as the file. */
function addFileBlock(meta: FileMeta, source: Source, restore?: Restore): Promise<Outcome> {
  if (meta.kind === "png") {
    if (!meta.blob) return Promise.resolve({ ok: false, reason: "no image data" });
    return addImageBlock(meta.blob, source, meta, restore);
  }
  const text = meta.text ?? "";
  const bytes = new TextEncoder().encode(text).length;
  const why = admit("text", bytes, blocks.length);
  if (why) return Promise.resolve({ ok: false, reason: why, transient: true });
  const pre = document.createElement("pre");
  pre.className = "wb-text";
  pre.textContent = text;
  const b = buildBlock("text", source, bytes, pre, meta, restore, text);
  setFileNote(b, meta);
  return Promise.resolve({ ok: true });
}

/** Path and size go in the tooltip only (2026-10-03: none of it needs showing); the
 *  visible note keeps just the warnings a reader acts on. */
function setFileNote(b: Block, meta: FileMeta | undefined, size?: string) {
  const warn = [
    meta?.truncated ? "preview truncated" : "",
    meta?.lossy ? "lossy decode" : "",
  ].filter(Boolean).join(" · ");
  b.note.textContent = warn;
  b.note.title = [meta?.path ?? "", size ?? ""].filter(Boolean).join(" — ");
}

/* ---- paste ---- */

// Synchronous extraction inside the trusted event: items are only readable
// here. xterm owns paste on its own textarea and stops propagation, and the
// pane is a sibling, not an ancestor, so one Ctrl+V never reaches both. The
// listener sits on the workbench root, so trayTakesPaste bails out first for
// any editable descendant (Document's editor, Display's comment box, Flow's
// inspector fields) — see workbench-paste.ts.
export function onPaste(e: ClipboardEvent) {
  if (!trayTakesPaste(e.target)) return;
  const dt = e.clipboardData;
  if (!dt) return;
  const items = [...dt.items];
  const png = items.find((i) => i.kind === "file" && i.type === "image/png");
  const otherImage = items.find((i) => i.kind === "file" && i.type.startsWith("image/"));
  const text = dt.getData("text/plain");
  if (!png && !otherImage && !text) return;
  e.preventDefault();
  if (png) {
    const blob = png.getAsFile();
    if (!blob) return note("Clipboard Image Unreadable");
    void addImageBlock(blob, "paste").then((r) => (r.ok ? notePasteLanded() : note(r.reason)));
    return;
  }
  if (otherImage) return note(`PNG Only (Got ${otherImage.type})`);
  const r = addTextBlock(text, "paste");
  if (r.ok) notePasteLanded();
  else note(r.reason);
}

/** A paste always lands in the tray and the view does not switch. On the Tray tab the new
 *  block is the confirmation, so no note; on another tab it would land
 *  unseen, so say where it went. */
function notePasteLanded() {
  if (!deps.trayActive()) deps.note(trayLandedNote(), true);
}
/** workbench.ts clears this note on the next header-tab switch (2026-10-05: it lingered). */
function trayLandedNote(): string {
  return `Added To ${moduleName("tray", "Tray")}`;
}

/* ---- drop ---- */

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// One batch per drop, serialised behind earlier batches. Failures accumulate
// into one summary note so a later success can't wipe them (5).
export function dropPaths(paths: string[]) {
  batchChain = batchChain.then(async () => {
    const fails: string[] = [];
    let added = 0;
    for (const path of paths) {
      const r = await addDroppedFile(path);
      if (r.ok) added++;
      else fails.push(`${basename(path)}: ${r.reason}`);
    }
    note(fails.length ? `drop: ${fails.join("; ")}` : "");
    if (added) deps.revealWorkbench();
  });
}

async function addDroppedFile(path: string, restore?: Restore): Promise<Outcome> {
  const name = basename(path);
  const ext = (name.includes(".") ? name.split(".").pop()! : "").toLowerCase();
  try {
    if (ext === "png") {
      const buf = await invoke("read_drop_png", { path });
      const blob = new Blob([buf], { type: "image/png" });
      return addFileBlock({ path, name, kind: "png", fileBytes: buf.byteLength, blob }, "drop", restore);
    }
    if (TEXT_EXT.has(ext)) {
      const r = await invoke("read_drop_text", { path });
      return addFileBlock(
        { path, name: r.name, kind: "text", fileBytes: r.bytes, text: r.text, truncated: r.truncated, lossy: r.lossy },
        "drop",
        restore,
      );
    }
    return { ok: false, reason: ext ? `.${ext} is not a supported type` : "no extension" };
  } catch (e) {
    // read_drop_png/read_drop_text rejected: the file is unreadable or gone
    // right now, which is not the same claim as "this block is bad".
    return { ok: false, reason: String(e), transient: true };
  }
}

/* ---- blocks ---- */

function buildBlock(kind: Block["kind"], source: Source, previewBytes: number, content: HTMLElement, file?: FileMeta, restore?: Restore, text?: string): Block {
  const el = document.createElement("article");
  el.className = `wb-block wb-${kind}`;
  const head = document.createElement("div");
  head.className = "wb-block-head";
  // a restored block keeps its entry's name and `at` instead of taking a
  // fresh one, so a consumer holding "Tray Alpha" still means the same block.
  // If that name is somehow already a live block's (shouldn't happen — restore
  // reserves it up front — but a defensive fallback beats two blocks sharing
  // a name), fall back to a fresh one instead of colliding.
  const name = restore && !blocks.some((b) => b.name === restore.name) ? restore.name : takeBlockName(blocks, nextId);
  releaseName(name); // claimed for real now — the reservation window is over
  const nameEl = document.createElement("span");
  nameEl.className = "wb-block-name";
  nameEl.textContent = name;
  const at = restore?.at ?? Date.now();
  const noteSpan = document.createElement("span");
  noteSpan.className = "wb-block-note";
  const actions = document.createElement("span");
  actions.className = "wb-actions";
  head.append(nameEl, noteSpan, actions);
  el.append(head, content);

  const b: Block = {
    id: ++nextId, name, gen: 0, kind, source, at, previewBytes, el, note: noteSpan,
    path: file?.path, fileBytes: file?.fileBytes, text, annotation: restore?.annotation,
  };
  const ann = mountAnnotation(b, () => publishEntry(b));
  el.appendChild(ann.area);
  const btn = (label: string, title: string, run: () => void) => {
    const x = document.createElement("button");
    x.textContent = label;
    x.title = title;
    x.addEventListener("click", run);
    actions.appendChild(x);
    return x;
  };
  // the block owns its feedback (b.note) and copy flow, so both buttons take `run`
  const copy = copyButton({ run: () => void copyContent(b) });
  // a truncated text preview is not the file, so Copy is off for it (images and whole text files copy)
  copy.disabled = !!file?.truncated;
  actions.append(
    copy,
    copyPathButton({ title: file ? "Copy Path" : "Save to bridge\\clips (once) and copy the path", run: () => void copyPathAction(b) }),
  );
  // Open earns its place when Document shows more than the tray: rendered markdown, or text the
  // preview cut short. A whole plain-text clip is already all on screen (2026-10-05).
  if (file && (/\.md$/i.test(file.name) || (/\.txt$/i.test(file.name) && file.truncated))) {
    btn("Open", "Open",() => void deps.openInDocument(file.path));
  }
  // Open in Browser only where the backend opens the file (.html/.htm); no disabled state, like Open
  if (isBrowserPath(file?.path)) {
    actions.append(openInBrowserButton({ path: () => b.path, note: (m) => { b.note.textContent = m; } }));
  }
  // Annotate sits last before ✕ (2026-10-05)
  actions.append(ann.button);
  // the whole bar is the toggle: collapse hides only the body (preview); head and actions stay.
  // Persisted in the entry. Inner buttons stop propagation so they never toggle.
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  const setCollapsed = (on: boolean) => {
    el.classList.toggle("wb-collapsed", on);
    head.setAttribute("aria-expanded", String(!on));
  };
  const toggle = () => {
    const on = !el.classList.contains("wb-collapsed");
    setCollapsed(on);
    b.collapsed = on || undefined;
    publishEntry(b);
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    if (e.target !== head || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    toggle();
  });
  actions.addEventListener("click", (e) => e.stopPropagation());
  actions.addEventListener("keydown", (e) => e.stopPropagation());
  setCollapsed(false);
  if (restore?.collapsed) {
    setCollapsed(true);
    b.collapsed = true;
  }
  const remove = btn("", "Archive", () => removeBlock(b));
  remove.className = "icon-btn";
  remove.setAttribute("aria-label", "Archive");
  remove.appendChild(iconImg("broom"));
  blocks.push(b);
  bodyEl.appendChild(el);
  el.scrollIntoView({ block: "nearest" });
  publishBlock(b);
  return b;
}

/** The only removal path (broom, archives the entry): bumps gen so in-flight actions bail,
 *  revokes the preview URL, drops DOM and array references. Idempotent. */
function removeBlock(b: Block) {
  b.gen++;
  if (b.url) URL.revokeObjectURL(b.url);
  b.url = b.blob = undefined;
  b.el.remove();
  const i = blocks.indexOf(b);
  if (i >= 0) blocks.splice(i, 1);
  void invoke("archive_workbench_entry", { name: b.name }).catch((e) => note(`Archive Failed: ${String(e)}`));
}
