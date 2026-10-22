// Workbench Document view: open a Markdown/text file beside the terminal, read
// it rendered, toggle to source, keep the reading position, get told when the
// file changed. Auto-reloads after two stable ticks, unless selection or edits
// need preserving; re-checks those guards after reading the replacement.
// Rendering lives in markdown-build.ts (tokenizer-only markdown-it, inert DOM, line maps).

import { invoke, listen } from "../ipc";
import { iconImg } from "../icon-img";
import { paneShell } from "./pane-shell";
import { copyButton, copyPathButton, isBrowserPath, OPEN_IN_BROWSER, openFolderButton, openInBrowserButton } from "./file-actions";
import { copyText } from "../clipboard";
import { mountComments, setCommentsDocument, wrapForComments } from "./comments";
import { mountOpenMenu, closeOpenMenu, setCatalog, setOpenDocLabel, clearOpenDocLabel } from "./document-open-menu";
import { renderMarkdownOrText } from "./markdown-build";
import { documentDialog as runDialog } from "./document-dialog";
import { colourDiffs, sourcePre } from "./document-diff";
import { publishDocument } from "./document-publish";
import { createWatcher } from "./document-watch";
import { createDisplayRenderer, type DisplayRenderer, type Painted } from "./display-render";

// The Open ▾ menu lives in document-open-menu.ts; ipc.ts keeps importing from here.
// The builder lives in markdown-build.ts; rendered.ts and rendered/cards.ts import it from here.
export { setCatalog } from "./document-open-menu";
export type { DocEntry } from "./document-open-menu";
export { renderMarkdownOrText } from "./markdown-build";

interface DocState {
  path: string;
  name: string;
  mtimeMs: number;
  text: string;
  lossy: boolean;
  revision: number;
  draft: string;
  conflict: boolean;
  scroll: { rendered: number; source: number };
  rendered: HTMLElement | null;
  dropped: Record<string, number>;
  fellBack: false | { reason: string };
}

let root: HTMLElement;
let scrollEl: HTMLElement;
let statusEl: HTMLElement;
let reloadBtn: HTMLButtonElement;
let saveBtn: HTMLButtonElement;
let locationBtn: HTMLButtonElement;
let externalBtn: HTMLButtonElement;
let copyBtn: HTMLButtonElement;
let copyPathBtn: HTMLButtonElement;
let browserBtn: HTMLButtonElement;
let noteFn: (msg: string) => void = () => {};
let doc: DocState | null = null;
/** bumped by open: every async path (open, reload, stat, scroll restore) checks it */
let docGen = 0;
let scrollRaf: number | undefined;
let writeChain: Promise<void> = Promise.resolve();
let saving = false;
/** a Display group file on screen (doc is null meanwhile): painted read-only by the Display renderer */
let visual: { path: string; name: string } | null = null;
let visualRenderer: DisplayRenderer;
/** the kind of open that began last: an overtaken visual paint re-shows the old visual only after a Markdown open */
let lastOpen: "doc" | "visual" = "doc";
const extOf = (p: string) => p.slice(p.lastIndexOf(".") + 1).toLowerCase();
const VISUAL_FILE = /\.(svg|html|png)$/i;

/* ---- mount ---- */

/** `reveal` opens the pane on this tab (the dev fixture runner needs it on screen). */
export function mountDocumentView(parent: HTMLElement, note: (msg: string) => void, reveal: () => void = () => {}): HTMLElement {
  noteFn = note;
  const shell = paneShell({ id: "doc-view", head: { id: "doc-bar" }, frame: { id: "doc-scroll" } });
  root = shell.root;
  shell.head.innerHTML = `
    <button id="doc-open" type="button" class="pick-face" aria-label="Open Document"> </button>
    <button id="doc-reload" class="hidden" title="Refresh" aria-label="Refresh"></button>
    <span id="doc-status" class="dim"></span>
    <button id="doc-save" class="hidden">Save</button>`;
  scrollEl = shell.frame;
  statusEl = root.querySelector<HTMLElement>("#doc-status")!;
  visualRenderer = createDisplayRenderer(scrollEl, { onNote: (n) => { if (visual) statusEl.textContent = n; } });
  reloadBtn = root.querySelector<HTMLButtonElement>("#doc-reload")!;
  reloadBtn.prepend(iconImg("refresh"));
  saveBtn = root.querySelector<HTMLButtonElement>("#doc-save")!;
  // the folder handler decides the app (File Pilot when it owns folders)
  locationBtn = openFolderButton({
    id: "doc-location", className: "hidden", path: openPath, note: (m) => noteFn(m),
  });
  externalBtn = document.createElement("button");
  externalBtn.id = "doc-external";
  externalBtn.className = "hidden";
  externalBtn.title = "Open Externally";
  externalBtn.append(iconImg("document-edit"));
  // Copy: the open visual's own content (svg/html source, png image); Markdown has none, so it stays hidden there
  copyBtn = copyButton({
    id: "doc-copy", className: "hidden", copy: copyVisual, note: (m) => noteFn(m),
  });
  copyPathBtn = copyPathButton({
    id: "doc-copy-path", className: "hidden", path: openPath, note: (m) => noteFn(m),
  });
  browserBtn = openInBrowserButton({
    id: "doc-browser", className: "hidden", path: openPath, note: (m) => noteFn(m),
  });
  // Settings › Document App, else the shell decides the app. It opens what is ON DISK,
  // so an unsaved draft earns a status line, not a block or a silent save.
  externalBtn.addEventListener("click", () => {
    if (!doc) return;
    const dirty = isDirty();
    externalBtn.disabled = true;
    invoke("open_document", { path: doc.path })
      .then((note) => {
        // a note = the Open With dialog ran; it says why and points at the setting
        const draft = dirty ? "opened the saved file — you have unsaved changes" : "";
        const text = [note, draft].filter(Boolean).join(" ");
        if (text) statusEl.textContent = text;
      })
      .catch((e) => noteFn(`open failed: ${String(e)}`))
      .finally(() => { externalBtn.disabled = false; });
  });
  parent.appendChild(root);
  // passage comments: toggle + request buttons join the bar; the margin lives
  // inside the scroll container (comments.ts)
  mountComments(root.querySelector<HTMLElement>("#doc-bar")!, scrollEl, (m) => { statusEl.textContent = m; });
  // link buttons: one right-aligned group at the end of the bar, Display's order and spacing
  const actions = document.createElement("div");
  actions.className = "display-actions";
  actions.append(copyBtn, copyPathBtn, browserBtn, locationBtn, externalBtn);
  root.querySelector("#doc-bar")!.append(actions);
  // `?.`: the node tests that mount this view have no Vite env. Loaded on demand so a test that
  // stubs panels/preview never meets the fixture runner's preview imports.
  if (import.meta.env?.DEV) {
    void import("./preview-fixtures").then((m) => m.mountFixtureRunner(shell.head, { reveal, note: statusEl, content: scrollEl }));
  }

  saveBtn.addEventListener("click", () => void saveDocument());
  reloadBtn.addEventListener("click", () => void reload());
  mountOpenMenu(root.querySelector<HTMLButtonElement>("#doc-open")!, {
    onNew: () => void newDocument(),
    onOpen: (path) => void openDocumentPath(path),
    openPath,
    onClear: () => void clearDocument(),
  });
  // throttled save; a hidden view never writes (offsetParent null) and the
  // pending save is flushed before any hide/toggle/reload
  scrollEl.addEventListener("scroll", () => {
    if (scrollRaf !== undefined) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = undefined; saveScroll(); });
  });
  window.addEventListener("beforeunload", (event) => {
    if (isDirty() || saving) { event.preventDefault(); event.returnValue = ""; }
  });
  // doc is null here: deletes a stale document.json a previous boot left behind,
  // so a restart's tray-restore never sees a document entry not backed by an
  // open document.
  publish();
  const refetch = () => void refetchCatalog().catch(() => {});
  refetch();
  // a review written while the tab is open shows up without a relaunch
  void listen("display-update", refetch);
  return root;
}

/* ---- state ---- */

/** Reload shows only while the file on disk differs from the loaded one; the label rides with it. */
function setReloadStale(on: boolean) {
  reloadBtn.classList.toggle("hidden", !on);
  reloadBtn.title = on ? "Refresh: the file changed on disk" : "Refresh"; // copy-ok: full-sentence tooltip
}
function publish() { publishDocument(doc); }
function openPath(): string | undefined { return doc?.path ?? visual?.path; }
/** Copy Path and Open in Browser show for the open file; only .html/.htm opens in the browser, the rest says why not. */
function showBrowser(path: string): void {
  copyPathBtn.classList.remove("hidden");
  browserBtn.classList.remove("hidden");
  const html = isBrowserPath(path);
  browserBtn.disabled = !html;
  browserBtn.title = html ? OPEN_IN_BROWSER : "HTML and Images Only";
}
/** Copy for the open visual: svg/html as source text, png as an image fetched from the painted URL
 *  (navigator.clipboard only: the text rescue cannot carry an image). null = no visual, click does nothing. */
export async function copyPainted(c: Painted): Promise<boolean> {
  if (c.kind !== "png") return copyText(c.content ?? "");
  if (!c.url) return false;
  try {
    const blob = await (await fetch(c.url)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}
function copyVisual(): Promise<boolean> | null {
  const c = visual ? visualRenderer.current() : null;
  return c ? copyPainted(c) : null;
}
function isDirty(): boolean { return !!doc && doc.draft !== doc.text; }
/** The draft differs from the loaded text: the state `mayDiscard` would prompt over. */
export function documentDirty(): boolean { return isDirty(); }
function autoBlocked(): boolean { return saving || isDirty() || !!root.querySelector("#doc-dialog") || !!window.getSelection()?.toString(); }

function documentDialog(message: string, action: string, inputName = false): Promise<string | null> {
  return runDialog(root, scrollEl, message, action, inputName);
}

async function mayDiscard(): Promise<boolean> {
  if (saving) { statusEl.textContent = "save in progress"; return false; }
  if (!isDirty()) return true;
  const d = doc, gen = docGen, draft = doc?.draft, revision = doc?.revision;
  const accepted = await documentDialog("Discard unsaved document changes?", "Discard");
  return accepted !== null && !saving && doc === d && docGen === gen && doc?.draft === draft && doc?.revision === revision;
}

async function newDocument() {
  if (!(await mayDiscard())) return;
  const gen = docGen;
  const name = await documentDialog("New document name (.md or .txt):", "Create", true);
  if (!name || gen !== docGen) return;
  try {
    const path = await invoke("create_document", { name });
    if (gen === docGen) await openDocumentPath(path);
    await refetchCatalog();
  } catch (e) { noteFn(`create failed: ${String(e)}`); }
}

function updateSave() {
  // Editable only when a document is open AND there is no rendered view to
  // show instead (a lossy fallback is view-only; a renderable doc has no
  // toggle into source anymore); doc === null must hide it too, not just
  // fall through both undefined checks as false.
  saveBtn.classList.toggle("hidden", !doc || !!doc.rendered || !!doc.lossy);
  saveBtn.disabled = saving || !isDirty() || !!doc?.conflict;
}

async function saveDocument() {
  const d = doc, gen = docGen;
  if (!d || d.lossy || d.conflict || saving || !isDirty()) return;
  const text = d.draft;
  saving = true;
  updateSave();
  writeChain = writeChain.then(async () => {
    try {
      const mtime = await invoke("write_document", { path: d.path, text, expectedMtime: d.mtimeMs });
      if (gen !== docGen || doc !== d) return;
      d.mtimeMs = mtime;
      d.text = text;
      const built = renderMarkdownOrText(d.name, text);
      d.rendered = built.fellBack ? null : built.el;
      d.dropped = built.dropped;
      d.fellBack = built.fellBack;
      d.revision++;
      statusEl.textContent = isDirty() ? "unsaved changes" : "Saved";
    } catch (e) {
      if (gen !== docGen || doc !== d) return;
      if (String(e).includes("conflict")) d.conflict = true;
      statusEl.textContent = d.conflict ? "changed on disk — reload before saving" : `save failed: ${String(e)}`;
    } finally { saving = false; updateSave(); }
  });
  await writeChain;
}

function saveScroll() {
  if (!doc || scrollEl.offsetParent === null) return; // hidden: never overwrite
  if (!doc.rendered) doc.scroll.source = scrollEl.scrollTop;
  else doc.scroll.rendered = scrollEl.scrollTop;
}

function flushScroll() {
  if (scrollRaf !== undefined) { cancelAnimationFrame(scrollRaf); scrollRaf = undefined; }
  saveScroll();
}

/** Restore after layout exists: next frame, guarded by docGen; if still
 *  hidden (workbench collapsed) the workbench-shown hook calls this again. */
function restoreScroll() {
  const gen = docGen, d = doc;
  if (!d) return;
  requestAnimationFrame(() => {
    if (gen !== docGen || doc !== d || scrollEl.offsetParent === null) return;
    scrollEl.scrollTop = !d.rendered ? d.scroll.source : d.scroll.rendered;
  });
}

/** Called by the workbench when the Document tab or the pane itself becomes visible. */
export function onDocumentShown() {
  restoreScroll();
}

/** Called by the workbench before the Document tab or the pane is hidden. */
export function onDocumentHidden() {
  flushScroll();
  // a body-appended, position: fixed panel sits outside #doc-view { display:
  // none } and would float over Display/Tray otherwise.
  closeOpenMenu();
}

function present() {
  if (!doc) return;
  // rendered view sits in the comments wrapper (margin + offer positioning);
  // the editable and read-only fallback views have no anchors and get none
  if (!doc.rendered && !doc.lossy) {
    wrapForComments(null);
    const editor = document.createElement("textarea");
    editor.className = "doc-source";
    editor.setAttribute("aria-label", "Document source");
    editor.style.cssText = "width:100%;min-height:60vh;box-sizing:border-box;resize:vertical;color:inherit;background:transparent;font:inherit;white-space:pre;";
    editor.value = doc.draft;
    const d = doc;
    editor.addEventListener("input", () => {
      if (doc !== d) return;
      d.draft = editor.value;
      statusEl.textContent = d.conflict ? "changed on disk — reload before saving" : isDirty() ? "unsaved changes" : "";
      updateSave();
    });
    scrollEl.replaceChildren(editor);
  }
  else if (!doc.rendered) { wrapForComments(null); scrollEl.replaceChildren(sourcePre(doc.text)); }
  else { scrollEl.replaceChildren(wrapForComments(doc.rendered)!); colourDiffs(scrollEl); }
  updateSave();
  copyBtn.classList.add("hidden"); // a Markdown document has no visual content to copy
  showBrowser(doc.path);
  setReloadStale(false);
  locationBtn.classList.remove("hidden");
  externalBtn.classList.remove("hidden");
  locationBtn.title = doc.path.replace(/[\\/][^\\/]*$/, "");
  setOpenDocLabel(doc.name, doc.path);
  const bits: string[] = [];
  if (doc.fellBack) bits.push(`source shown: ${doc.fellBack.reason}`);
  else {
    const d = Object.entries(doc.dropped).map(([k, n]) => `${n} ${k}`);
    if (d.length) bits.push(`dropped: ${d.join(", ")}`);
  }
  if (doc.lossy) bits.push("lossy decode");
  if (doc.conflict) bits.push("changed on disk — reload before saving");
  else if (isDirty()) bits.push("unsaved changes");
  statusEl.textContent = bits.join(" · ");
  restoreScroll();
}

/* ---- open / reload / watch ---- */

async function load(path: string, gen: number): Promise<DocState | null> {
  const r = await invoke("read_document", { path });
  if (gen !== docGen) return null;
  const built = renderMarkdownOrText(r.name, r.text);
  return {
    path, name: r.name, mtimeMs: r.mtimeMs, text: r.text, lossy: r.lossy,
    revision: 0, scroll: { rendered: 0, source: 0 },
    draft: r.text, conflict: false,
    rendered: built.fellBack ? null : built.el, dropped: built.dropped, fellBack: built.fellBack,
  };
}

/** Always re-reads the path — a tray preview is never treated as the document. */
export async function openDocumentPath(path: string): Promise<boolean> {
  if (VISUAL_FILE.test(path)) return openVisual(path);
  if (!(await mayDiscard())) return false;
  const previous = doc, approvedDraft = doc?.draft;
  const loadedRevision = previous?.revision;
  lastOpen = "doc";
  const gen = ++docGen;
  flushScroll();
  statusEl.textContent = "opening…";
  try {
    const next = await load(path, gen);
    if (!next || gen !== docGen) return false;
    // Save may have completed during the read, clearing `saving` again.
    if (previous?.revision !== loadedRevision) return false;
    if (saving || (doc === previous && doc?.draft !== approvedDraft && !(await mayDiscard()))) return false;
    // DOM confirmation yields too; a newer Open or Save must still win.
    if (gen !== docGen || doc !== previous || saving || previous?.revision !== loadedRevision) return false;
    leaveVisual();
    doc = next;
    publish();
    setCommentsDocument({ path: next.path, name: next.name }); // sidecar read is async; layout follows
    present();
    startWatch();
    return true;
  } catch (e) {
    if (gen !== docGen) return false;
    statusEl.textContent = `open failed: ${e}`; // old document (if any) stays readable
    return false;
  } finally {
    // Every rejected/failed Open advanced the generation of its retained watcher.
    if (gen === docGen && doc === previous && doc) startWatch();
  }
}

/** The × on the Open button: back to the empty Docs screen, as before anything was picked.
 *  publish() with no document deletes document.json, so a relaunch opens empty too. */
async function clearDocument(): Promise<void> {
  if (!doc && !visual) return;
  if (!(await mayDiscard())) return;
  flushScroll();
  ++docGen; // every in-flight open, reload and stat check bails
  watcher.stop();
  visualRenderer.clear();
  visual = null;
  doc = null;
  publish();
  setCommentsDocument(null);
  wrapForComments(null);
  scrollEl.classList.remove("doc-visual");
  scrollEl.replaceChildren();
  updateSave();
  setReloadStale(false);
  for (const b of [externalBtn, copyBtn, copyPathBtn, browserBtn, locationBtn]) b.classList.add("hidden");
  statusEl.textContent = "";
  clearOpenDocLabel();
}

/** A Display group file (.svg/.html/.png on top of bridge\display): painted by the Display
 *  renderer through its own readers, read-only. No editor, Save, comments or stat poll; doc
 *  stays null while it is up. Approve and Deny stay in Relay. */
async function openVisual(path: string): Promise<boolean> {
  if (!(await mayDiscard())) return false;
  const prev = doc, approvedDraft = doc?.draft;
  lastOpen = "visual";
  const gen = ++docGen;
  flushScroll();
  statusEl.textContent = "opening…"; // copy-ok: the Markdown open's status line, reused
  scrollEl.classList.add("doc-visual"); // anchors the renderer's staged frame
  const r = await visualRenderer.show({ path, kind: extOf(path), mtime_ms: 0 });
  if (gen !== docGen) {
    // a newer open overtook this paint before committing: put back what was up
    if (r && !("error" in r)) {
      visualRenderer.clear();
      if (doc) present();
      // after a Markdown open (which may still fail) the old visual goes back; a newer visual open paints its own
      else if (visual && (lastOpen as string) === "doc") void visualRenderer.show({ path: visual.path, kind: extOf(visual.path), mtime_ms: 0 });
      if (!visual) scrollEl.classList.remove("doc-visual");
    }
    return false;
  }
  if (!r) {
    // cleared with nothing painted: restore what was up, as the error branch does
    if (!visual) scrollEl.classList.remove("doc-visual");
    if (doc) { present(); startWatch(); }
    return false;
  }
  if ("error" in r) {
    if (!visual) scrollEl.classList.remove("doc-visual");
    statusEl.textContent = `open failed: ${r.error}`; // copy-ok: the Markdown open's failure line, reused; the previous file stays up
    if (doc) startWatch(); // this open advanced the generation its watcher holds
    return false;
  }
  // The paint awaited (up to 1500 ms staging an HTML frame): typing or a Save may have landed since mayDiscard.
  if (doc !== prev || saving || doc?.draft !== approvedDraft) {
    visualRenderer.clear();
    if (!visual) scrollEl.classList.remove("doc-visual");
    if (doc) { present(); startWatch(); }
    return false;
  }
  watcher.stop();
  doc = null;
  publish();
  setCommentsDocument(null);
  wrapForComments(null);
  visual = { path, name: path.split(/[\\/]/).pop() ?? path };
  updateSave();
  setReloadStale(false);
  externalBtn.classList.add("hidden"); // open_document takes .md/.txt only (chrome.rs DOC_EXTS)
  copyBtn.classList.remove("hidden");
  showBrowser(path);
  locationBtn.classList.remove("hidden");
  locationBtn.title = path.replace(/[\\/][^\\/]*$/, "");
  setOpenDocLabel(visual.name, path);
  statusEl.textContent = r.note;
  return true;
}

/** Lower-cased paths of the last catalog's Display group, so a refetch can tell a visual that
 *  left the group from one that was never listed in it. */
let displayPaths = new Set<string>();

/** Catalog refetch: an open visual the previous catalog listed under Display and this one does
 *  not was deleted or aged out of bridge\display. */
/** The scan runs off the main thread, so replies can cross: only the newest request applies. */
let catalogSeq = 0;
async function refetchCatalog(): Promise<void> {
  const seq = ++catalogSeq;
  const entries = await invoke("list_documents");
  if (seq === catalogSeq) applyCatalog(entries);
}
function applyCatalog(entries: Parameters<typeof setCatalog>[0]) {
  setCatalog(entries);
  const previous = displayPaths;
  displayPaths = new Set(entries.filter((e) => e.group === "Display").map((e) => e.path.toLowerCase()));
  const open = visual?.path.toLowerCase();
  if (open && previous.has(open) && !displayPaths.has(open)) {
    statusEl.textContent = "This file was removed from Display."; // copy-ok: full-sentence note, the user's text
  }
}

/** A Markdown document is about to go up: drop the visual and any paint still pending. */
function leaveVisual() {
  visualRenderer.clear();
  visual = null;
  scrollEl.classList.remove("doc-visual");
}

async function reload(automatic = false, stableMtime?: number) {
  if (!doc) return;
  if (automatic ? autoBlocked() : !(await mayDiscard())) return;
  if (!doc) return;
  const gen = docGen, prev = doc;
  const loadedRevision = prev.revision;
  const approvedDraft = prev.draft;
  flushScroll();
  statusEl.textContent = "reloading…";
  try {
    const next = await load(prev.path, gen);
    if (!next || gen !== docGen || doc !== prev) return;
    // A completed Save makes this in-flight read stale even with no dirty draft.
    if (prev.revision !== loadedRevision) return;
    if (automatic && next.mtimeMs !== stableMtime) return;
    if (automatic ? autoBlocked() : saving || (prev.draft !== approvedDraft && !(await mayDiscard()))) return;
    if (gen !== docGen || doc !== prev || saving || prev.revision !== loadedRevision) return;
    next.revision = prev.revision + 1; // only on a committed successful load
    next.scroll = { ...prev.scroll };
    doc = next;
    publish();
    setReloadStale(false);
    present();
  } catch (e) {
    if (gen !== docGen || doc !== prev) return;
    statusEl.textContent = `reload failed: ${e}`; // old content and its notice stay
  }
}

// The open path is watched (document-watch.ts), whatever the catalog window shows.
const watcher = createWatcher<DocState>({
  gen: () => docGen,
  doc: () => doc,
  isDirty,
  autoBlocked,
  setReloadStale,
  updateSave,
  setStatus: (text) => { statusEl.textContent = text; },
  reload: (automatic, stableMtime) => reload(automatic, stableMtime),
});
const startWatch = watcher.start;
