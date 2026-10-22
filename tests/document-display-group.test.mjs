// Document's Display group: the catalog's top-level bridge\display visuals list as a "Display"
// folder (searchable, folder label Display), and opening one mounts the Display renderer
// read-only: no editor, no Save, no comment controls, no stat poll.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    "panels/sessions": "export const getActiveSessionId = () => null; export const writeToSession = () => {}; export const openWorkbench = () => {}; export const isWorkbenchOpen = () => true;",
    "panels/preview": `export function renderPreview(kind, content) {
      if (kind === 'html') {
        // a staged frame whose load the test fires itself, so the staging window is deterministic
        const el = document.createElement('iframe'); el.className = 'display-render'; el.dataset.content = content;
        const add = el.addEventListener.bind(el);
        el.addEventListener = (t, fn, o) => { if (t === 'load') globalThis.__frameLoad = fn; else add(t, fn, o); };
        return { el, dropped: {}, fellBack: null };
      }
      const el = document.createElement('div'); el.className = 'display-render'; el.dataset.content = content;
      return { el, dropped: {}, fellBack: null };
    }`,
    "clipboard": "export async function copyText(t) { (globalThis.__copied ??= []).push(t); return true; }",
    "icons": "export function lucide() { return document.createElement('span'); }",
  },
});
Object.assign(globalThis, {
  HTMLImageElement: dom.window.HTMLImageElement,
  HTMLIFrameElement: dom.window.HTMLIFrameElement,
});
const note = { path: "D:\\docs\\inbox\\Note.md", kind: "md", mtime_ms: 500, group: "Inbox" };
const drawing = { path: "D:\\display\\Drawing.svg", kind: "svg", mtime_ms: 400, group: "Display" };
Object.assign(dom.ipc.answers, {
  list_documents: [note, drawing],
  read_document: ({ path }) => ({ name: path.split("\\").pop(), bytes: 7, mtimeMs: 1, text: "# Note\n", lossy: false }),
  stat_document: 1,
  read_display_file: ({ path }) => ({ kind: "svg", content: path, sha256: "test" }),
  write_workbench_entry: null,
  delete_workbench_entry: null,
});
const big = { path: "D:\\docs\\inbox\\Big.md" };
const page = { path: "D:\\display\\Page.html", kind: "html", mtime_ms: 300, group: "Display" };
Object.assign(dom.ipc.answers, {
  read_document: ({ path }) => ({
    name: path.split("\\").pop(), bytes: 7, mtimeMs: 1, lossy: false,
    text: path === big.path ? "x".repeat(2 * 1024 * 1024 + 1) : "# Note\n",
  }),
  read_display_file: ({ path }) => ({ kind: path.endsWith(".html") ? "html" : "svg", content: path, sha256: "test" }),
});
// the stat poll's interval, tracked so a test can assert it is stopped without sleeping a period
const liveIntervals = new Set();
{
  const w = dom.window, set = w.setInterval.bind(w), clr = w.clearInterval.bind(w);
  w.setInterval = (...a) => { const id = set(...a); liveIntervals.add(id); return id; };
  w.clearInterval = (id) => { liveIntervals.delete(id); clr(id); };
}
const { mountDocumentView, openDocumentPath, documentDirty, copyPainted } = await import("../src/panels/document.ts");
const settle = async () => { for (let i = 0; i < 4; i++) await dom.flush(); };
const calls = (cmd) => dom.ipc.invoked.filter((c) => c === cmd).length;

test("a Display entry lists in its own group and opens read-only through the Display renderer", async () => {
  const view = mountDocumentView(document.body, () => {});
  await settle();
  // a Markdown document first, so its editor, comments and stat poll would be live
  assert.equal(await openDocumentPath(note.path), true);

  view.querySelector("#doc-open").click();
  const folds = [...document.querySelectorAll(".doc-om-fold")];
  assert.deepEqual(folds.map((f) => f.dataset.folder), ["Inbox", "Display"]);
  const displayFold = folds[1];
  assert.equal(displayFold.querySelector(".nm").textContent, "Display");
  assert.ok(displayFold.querySelector(".gi").firstChild, "the Display colour icon fills the slot");

  // searchable like any other row, and the result names its folder Display
  const search = document.querySelector(".doc-om-search");
  search.value = "drawing";
  search.dispatchEvent(new dom.window.Event("input"));
  const hits = [...document.querySelectorAll(".doc-om-file")];
  assert.deepEqual(hits.map((r) => r.dataset.value), [drawing.path]);
  assert.equal(hits[0].querySelector(".t").textContent, "Display");

  const reads = calls("read_document");
  hits[0].click();
  await settle();
  assert.equal(calls("read_display_file"), 1, "painted through the Display readers");
  assert.equal(calls("read_document"), reads, "never through the document reader");
  const scroll = view.querySelector("#doc-scroll");
  assert.equal(scroll.querySelector(".display-render")?.dataset.content, drawing.path);
  assert.equal(scroll.querySelector("textarea"), null, "no editor");
  assert.ok(view.querySelector("#doc-save").classList.contains("hidden"), "no Save");
  assert.ok(view.querySelector("#doc-comments").classList.contains("hidden"), "no comments toggle");
  assert.ok(view.querySelector("#doc-request").classList.contains("hidden"), "no Revise");
  assert.ok(view.querySelector("#doc-external").classList.contains("hidden"), "Open Externally takes .md/.txt only");
  assert.equal(view.querySelector("#doc-bar .decision-pair, #doc-bar [data-verdict]"), null, "no gate control");

  // the stat poll is off for it: its interval was cleared when the visual went up
  assert.equal(liveIntervals.size, 0, "no stat poll while a visual is open");

  // back to Markdown: the editor path is as before
  assert.equal(await openDocumentPath(note.path), true);
  assert.equal(scroll.querySelector(".display-render"), null);
  assert.ok(!scroll.classList.contains("doc-visual"));
  assert.equal(liveIntervals.size, 1, "the Markdown stat poll runs again");
  // and back to the visual, which also stops the Markdown stat poll so the test process exits
  assert.equal(await openDocumentPath(drawing.path), true);
  assert.ok(scroll.classList.contains("doc-visual"));
  assert.equal(liveIntervals.size, 0);
});

test("typing while an HTML visual stages keeps the draft and never shows the visual", async () => {
  const view = mountDocumentView(document.body, () => {});
  await settle();
  // a document over the render cap falls back to the editable source view (a textarea)
  assert.equal(await openDocumentPath(big.path), true);
  const scroll = view.querySelector("#doc-scroll");
  const area = scroll.querySelector("textarea");
  assert.ok(area, "the source editor is up");
  const pending = openDocumentPath(page.path);
  await settle(); // mayDiscard passed; the frame is staged and waiting on its load
  assert.ok(globalThis.__frameLoad, "the HTML frame is staging");
  area.value = "typed during the paint";
  area.dispatchEvent(new dom.window.Event("input"));
  globalThis.__frameLoad();
  assert.equal(await pending, false, "the open yields to the typed edit");
  assert.equal(scroll.querySelector("iframe"), null, "the visual is not shown");
  assert.equal(scroll.querySelector("textarea")?.value, "typed during the paint", "the draft is kept");
  assert.equal(liveIntervals.size, 1, "the document's stat poll runs again");
  // restore the loaded text so the draft is clean and the next test's open is not held by the discard dialog
  const again = scroll.querySelector("textarea");
  again.value = "x".repeat(2 * 1024 * 1024 + 1);
  again.dispatchEvent(new dom.window.Event("input"));
});

test("a visual that leaves the catalog says it was removed from Display", async () => {
  const view = mountDocumentView(document.body, () => {});
  await settle();
  assert.equal(await openDocumentPath(drawing.path), true);
  dom.ipc.answers.list_documents = [note];
  dom.ipc.listeners["display-update"]?.();
  await settle();
  assert.equal(view.querySelector("#doc-status")?.textContent, "This file was removed from Display.");
  dom.ipc.answers.list_documents = [note, drawing];
});

test("a visual the previous catalog never listed under Display gets no removed notice", async () => {
  const view = mountDocumentView(document.body, () => {});
  await settle();
  const unlisted = "D:\\display\\Unlisted.svg";
  assert.equal(await openDocumentPath(unlisted), true);
  const status = view.querySelector("#doc-status");
  status.textContent = "";
  dom.ipc.listeners["display-update"]?.();
  await settle();
  assert.notEqual(status.textContent, "This file was removed from Display.");
});

test("Copy shows for a visual and copies its source; Markdown and an empty view hide it", async () => {
  const view = mountDocumentView(document.body, () => {});
  await settle();
  const copy = view.querySelector("#doc-copy");
  const pathBtn = view.querySelector("#doc-copy-path");
  assert.ok(copy.classList.contains("hidden"), "nothing open: hidden");
  assert.deepEqual([...view.querySelectorAll(".display-actions > button")].slice(0, 2).map((b) => b.id), ["doc-copy", "doc-copy-path"], "Copy, then Copy Path");
  assert.equal(await openDocumentPath(note.path), true);
  assert.ok(copy.classList.contains("hidden"), "Markdown: hidden");
  assert.ok(!pathBtn.classList.contains("hidden"));
  globalThis.__copied = [];
  assert.equal(await openDocumentPath(drawing.path), true);
  assert.ok(!copy.classList.contains("hidden"), "svg visual: shown");
  copy.click();
  await settle();
  assert.deepEqual(globalThis.__copied, [drawing.path], "the svg source goes through copyText");
  assert.equal(await openDocumentPath(note.path), true);
  assert.ok(copy.classList.contains("hidden"), "back to Markdown: hidden");
  assert.equal(await openDocumentPath(drawing.path), true); // stops the Markdown stat poll
});

test("Open in Browser sits beside Copy Path: enabled for html, disabled with HTML Only otherwise", async () => {
  const view = mountDocumentView(document.body, () => {});
  await settle();
  const btn = view.querySelector("#doc-browser");
  assert.ok(btn.classList.contains("hidden"), "nothing open: hidden");
  assert.deepEqual([...view.querySelectorAll(".display-actions > button")].slice(0, 3).map((b) => b.id), ["doc-copy", "doc-copy-path", "doc-browser"]);
  assert.equal(await openDocumentPath(page.path), true);
  assert.ok(!btn.classList.contains("hidden"));
  assert.equal(btn.disabled, false, "html: enabled");
  assert.equal(await openDocumentPath(note.path), true);
  assert.ok(!btn.classList.contains("hidden"));
  assert.equal(btn.disabled, true, "md: disabled");
  assert.equal(btn.title, "HTML and Images Only");
  assert.equal(await openDocumentPath(drawing.path), true); // stops the Markdown stat poll
});

test("copyPainted puts a png on the clipboard as an image/png item", async () => {
  // the harness paints no png (no decode, no object URLs), so the pure helper is tested with stubs
  const written = [];
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const blob = { type: "image/png" };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { write: async (items) => { written.push(...items); } } } });
  globalThis.ClipboardItem = class { constructor(parts) { this.parts = parts; } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { assert.equal(url, "blob:png"); return { blob: async () => blob }; };
  try {
    assert.equal(await copyPainted({ kind: "png", url: "blob:png", content: null }), true);
    assert.equal(written.length, 1);
    assert.equal(written[0].parts["image/png"], blob);
    assert.equal(await copyPainted({ kind: "png", url: null, content: null }), false, "no painted URL: fails");
    globalThis.__copied = [];
    assert.equal(await copyPainted({ kind: "html", url: null, content: "<p>x</p>" }), true);
    assert.deepEqual(globalThis.__copied, ["<p>x</p>"]);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.ClipboardItem;
    if (had) Object.defineProperty(globalThis, "navigator", had); else delete globalThis.navigator;
  }
});

test("documentDirty is true only while the draft differs from the loaded text", async () => {
  const view = mountDocumentView(document.body, () => {});
  await settle();
  try {
    assert.equal(await openDocumentPath(big.path), true);
    assert.equal(documentDirty(), false);
    const scroll = view.querySelector("#doc-scroll");
    const area = scroll.querySelector("textarea");
    area.value = "edited";
    area.dispatchEvent(new dom.window.Event("input"));
    assert.equal(documentDirty(), true);
    area.value = "x".repeat(2 * 1024 * 1024 + 1);
    area.dispatchEvent(new dom.window.Event("input"));
    assert.equal(documentDirty(), false);
  } finally {
    // a visual again stops the Markdown stat poll so the test process exits
    await openDocumentPath(drawing.path);
  }
});

test("the × on the Open button clears the document, stays out of the menu, and shows only while one is open", async () => {
  const view = mountDocumentView(document.body, () => {});
  await settle();
  const face = view.querySelector("#doc-open");
  assert.equal(face.querySelector(".doc-open-clear"), null, "no document, no ×");
  assert.equal(await openDocumentPath(note.path), true);
  const x = face.querySelector(".doc-open-clear");
  assert.ok(x, "× shows while a document is open");
  assert.equal(x.getAttribute("aria-label"), "Clear");
  assert.equal(x.title, "Clear");
  assert.equal(x.tabIndex, 0);
  // click clears without opening the dropdown
  x.click();
  await settle();
  assert.equal(document.getElementById("doc-om"), null, "the click never reaches the trigger");
  assert.equal(face.querySelector(".doc-open-clear"), null);
  assert.equal(face.title, "");
  assert.equal(view.querySelector("#doc-scroll").children.length, 0, "the empty Docs screen");
  assert.equal(documentDirty(), false);
  assert.ok(dom.ipc.invoked.includes("delete_workbench_entry"), "the persisted open document is deleted");
  // keyboard: Enter on the × of a freshly opened document clears it too
  assert.equal(await openDocumentPath(note.path), true);
  const x2 = face.querySelector(".doc-open-clear");
  x2.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
  assert.equal(document.getElementById("doc-om"), null);
  assert.equal(face.querySelector(".doc-open-clear"), null);
  // a Display visual clears the same way
  assert.equal(await openDocumentPath(drawing.path), true);
  face.querySelector(".doc-open-clear").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
  await settle();
  assert.equal(face.querySelector(".doc-open-clear"), null);
  assert.equal(view.querySelector("#doc-scroll").children.length, 0);
});
