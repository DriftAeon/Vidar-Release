// Workbench Document passage comments. A sidecar
// `<doc>.comments.json` beside a document under bridge\display; Vidar is the
// ONLY writer — an agent reads it and answers in the plan's next revision, so
// there is no merge and no conflict policy. Anchors are the rendered blocks'
// data-line-start/end (zero-based, end-exclusive); after a reload a comment
// whose block range no longer contains its quote drops to the unanchored group
// — nothing is relocated, nothing is written on read. Every string from the
// sidecar lands via textContent/value, never innerHTML.

import { invoke } from "../ipc";
import { iconImg } from "../icon-img";
import { getActiveSessionId, writeToSession } from "./sessions";

interface Comment {
  id: string;
  lineStart: number;
  lineEnd: number;
  quote: string;
  text: string;
  atMs: number;
  status: "open" | "resolved";
}
export interface CommentsFile { version: number; doc: string; comments: Comment[] }

const QUOTE_MAX = 500;
const TEXT_MAX = 2000;
const NARROW_PX = 560; // below this the margin becomes gutter markers
const GAP = 6;
const REQUEST_MAX_BYTES = 300;
const OFFER_DELAY_MS = 150;

interface Target { path: string; name: string }
interface Pending { start: number; end: number; quote: string; rect: DOMRect }

let target: Target | null = null;
let list: Comment[] = [];
let enabled = false;
let disabledWhy = "";
let show = true;
let foldResolved = true;
let expandedId: string | null = null; // narrow mode: the one card shown as a popover
let draft: Comment | null = null; // being written; not in `list` until saved
let chain: Promise<void> = Promise.resolve(); // saves are serialised, never concurrent
let gen = 0; // bumped by setCommentsDocument: every async path checks it

let scrollEl: HTMLElement;
let statusFn: (msg: string) => void = () => {};
let toggleBtn: HTMLButtonElement;
let countEl: HTMLElement; // "(n)" beside the message-square-text glyph; empty while comments are off
let requestBtn: HTMLButtonElement;
let root: HTMLElement | null = null; // rendered Markdown root (null in source/fallback view)
let body: HTMLElement | null = null; // positioned wrapper: root + margin
let margin: HTMLElement | null = null;
let offerBtn: HTMLButtonElement | null = null;
let pending: Pending | null = null;
let selTimer: number | undefined;
let layoutRaf: number | undefined;
/** anchor block → the cards anchored on it (hover in either direction) */
let blockCards = new Map<Element, HTMLElement[]>();

/* ---- mount ---- */

export function mountComments(bar: HTMLElement, scroll: HTMLElement, status: (msg: string) => void) {
  scrollEl = scroll;
  statusFn = status;
  toggleBtn = document.createElement("button");
  toggleBtn.id = "doc-comments";
  toggleBtn.className = "hidden";
  countEl = document.createElement("span");
  countEl.className = "lbl";
  toggleBtn.append(iconImg("comments"), countEl);
  toggleBtn.addEventListener("click", () => { show = !show; layout(); });
  requestBtn = document.createElement("button");
  requestBtn.id = "doc-request";
  requestBtn.className = "hidden";
  requestBtn.textContent = "Revise";
  requestBtn.addEventListener("click", () => void requestRevision());
  bar.append(toggleBtn, requestBtn);

  // selectionchange, not mouseup: keyboard selection must offer too. The range
  // is cloned at offer time; the button's mousedown is prevented so the click
  // can't collapse the selection first.
  document.addEventListener("selectionchange", () => {
    if (selTimer !== undefined) clearTimeout(selTimer);
    selTimer = window.setTimeout(offerFromSelection, OFFER_DELAY_MS);
  });
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.altKey && !e.shiftKey && e.key.toLowerCase() === "m" && pending) {
      e.preventDefault();
      beginComment();
    }
  });
  new ResizeObserver(() => scheduleLayout()).observe(scrollEl);
  scrollEl.addEventListener("mouseover", (e) => hoverBlock(e, true));
  scrollEl.addEventListener("mouseout", (e) => hoverBlock(e, false));
}

/* ---- document lifecycle (called by document.ts) ---- */

export function setCommentsDocument(t: Target | null) {
  const g = ++gen;
  target = t;
  list = [];
  enabled = false;
  disabledWhy = "";
  draft = null;
  pending = null;
  expandedId = null;
  hideOffer();
  updateBar();
  if (!t) return;
  invoke("read_comments", { docPath: t.path }).then(
    (f) => {
      if (g !== gen) return;
      list = f.comments;
      enabled = true;
      updateBar();
      scheduleLayout();
    },
    (e) => {
      if (g !== gen) return;
      disabledWhy = String(e);
      updateBar();
    },
  );
}

/** Wrap the rendered root for presentation: the wrapper is the positioning
 *  context for the margin and the offer button. Source view passes null. */
export function wrapForComments(rendered: HTMLElement | null): HTMLElement | null {
  blockCards = new Map();
  hideOffer();
  if (!rendered) { root = body = margin = null; return null; }
  root = rendered;
  body = document.createElement("div");
  body.id = "doc-body";
  margin = document.createElement("div");
  margin.id = "doc-margin";
  body.append(rendered, margin);
  scheduleLayout();
  return body;
}

function updateBar() {
  const has = target !== null;
  toggleBtn.classList.toggle("hidden", !has);
  requestBtn.classList.toggle("hidden", !has || !enabled);
  toggleBtn.disabled = !enabled;
  const open = list.filter((c) => c.status === "open").length;
  countEl.textContent = enabled ? `(${open})` : "";
  toggleBtn.title = enabled ? (show ? "Hide margin" : "Show margin") : `Unavailable: ${disabledWhy || "bridge\\display only"}`;
}

/* ---- selection → offer ---- */

function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function elementAt(node: Node, offset: number, isEnd: boolean): Element | null {
  if (node.nodeType === Node.TEXT_NODE) return node.parentElement;
  const el = node as Element;
  // an element container indexes its children: an exclusive end offset names
  // the child BEFORE it
  const child = isEnd ? el.childNodes[offset - 1] : el.childNodes[offset];
  if (!child) return el;
  return child.nodeType === Node.TEXT_NODE ? child.parentElement : (child as Element);
}

function blockOf(el: Element | null): HTMLElement | null {
  const b = el?.closest<HTMLElement>("[data-line-start]") ?? null;
  return b && root && root.contains(b) ? b : null;
}

function offerFromSelection() {
  pending = null;
  if (!root || !body || !enabled || draft) return hideOffer();
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideOffer();
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return hideOffer();
  const sb = blockOf(elementAt(r.startContainer, r.startOffset, false));
  const eb = blockOf(elementAt(r.endContainer, r.endOffset, true));
  if (!sb || !eb) return hideOffer();
  const quote = normalise(r.toString()).slice(0, QUOTE_MAX);
  if (!quote) return hideOffer();
  const rects = r.getClientRects();
  const last = rects[rects.length - 1] ?? r.getBoundingClientRect();
  pending = {
    start: Number(sb.dataset.lineStart),
    end: Number(eb.dataset.lineEnd),
    quote,
    rect: last,
  };
  if (!(pending.start < pending.end)) { pending = null; return hideOffer(); }
  showOffer(last);
}

function showOffer(at: DOMRect) {
  if (!body) return;
  if (!offerBtn) {
    offerBtn = document.createElement("button");
    offerBtn.id = "doc-offer";
    offerBtn.textContent = "Comment";
    offerBtn.title = "Comment (Ctrl+Alt+M)";
    offerBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
    offerBtn.addEventListener("click", (e) => { e.stopPropagation(); beginComment(); });
  }
  body.appendChild(offerBtn);
  const br = body.getBoundingClientRect();
  const left = Math.max(0, Math.min(at.right - br.left, body.clientWidth - 70));
  offerBtn.style.left = `${left}px`;
  offerBtn.style.top = `${at.bottom - br.top + 4}px`;
}

function hideOffer() {
  offerBtn?.remove();
}

function beginComment() {
  if (!pending || !enabled || draft) return;
  const p = pending;
  pending = null;
  hideOffer();
  window.getSelection()?.removeAllRanges();
  draft = {
    id: crypto.randomUUID(),
    lineStart: p.start,
    lineEnd: p.end,
    quote: p.quote,
    text: "",
    atMs: Date.now(),
    status: "open",
  };
  show = true;
  expandedId = draft.id;
  layout();
  margin?.querySelector<HTMLTextAreaElement>(".doc-card.editing textarea")?.focus();
}

/* ---- persistence: Vidar is the only writer ---- */

function persist() {
  const t = target;
  if (!t) return;
  const g = gen;
  const file: CommentsFile = { version: 1, doc: t.name, comments: list };
  const json = JSON.stringify(file);
  chain = chain
    .then(() => invoke("save_comments", { docPath: t.path, json }))
    .then(
      () => { if (g === gen) statusFn(""); },
      (e) => { if (g === gen) statusFn(`comments save failed: ${e}`); }, // the list stays in memory: nothing typed is lost
    );
}

function commitDraft(text: string) {
  if (!draft) return;
  const body = text.trim().slice(0, TEXT_MAX);
  if (!body) return;
  draft.text = body;
  list.push(draft);
  draft = null;
  expandedId = null;
  updateBar();
  persist();
  layout();
}

function discardDraft() {
  draft = null;
  expandedId = null;
  layout();
}

function setStatus(c: Comment, status: Comment["status"]) {
  c.status = status;
  updateBar();
  persist();
  layout();
}

function remove(c: Comment) {
  list = list.filter((x) => x !== c);
  if (expandedId === c.id) expandedId = null;
  updateBar();
  persist();
  layout();
}

/* ---- anchoring ---- */

/** Outermost mapped blocks whose start lies in [lineStart, lineEnd). Nested
 *  blocks (list > item > paragraph) collapse to the outermost so a comment
 *  highlights once. */
function blocksFor(c: Comment): HTMLElement[] {
  if (!root) return [];
  const out: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-line-start]")) {
    const s = Number(el.dataset.lineStart);
    if (!(s >= c.lineStart && s < c.lineEnd)) continue;
    if (out.some((o) => o.contains(el))) continue;
    out.push(el);
  }
  return out;
}

function stillMatches(c: Comment, blocks: HTMLElement[]): boolean {
  if (!blocks.length) return false;
  const text = normalise(blocks.map((b) => b.textContent ?? "").join(" "));
  return text.includes(c.quote);
}

/* ---- layout ---- */

function scheduleLayout() {
  if (layoutRaf !== undefined) return;
  layoutRaf = requestAnimationFrame(() => { layoutRaf = undefined; layout(); });
}

function layout() {
  if (!root || !body || !margin) return;
  for (const el of root.querySelectorAll(".doc-anchor, .doc-anchor-hot")) el.classList.remove("doc-anchor", "doc-anchor-hot");
  blockCards = new Map();
  margin.replaceChildren();
  const on = show && enabled && (list.length > 0 || draft !== null);
  const narrow = scrollEl.clientWidth < NARROW_PX;
  body.classList.toggle("with-margin", on && !narrow);
  margin.classList.toggle("narrow", narrow);
  margin.classList.toggle("hidden", !on);
  if (!on) return;

  // Pass 1: every layout read (the anchors' tops) before any write.
  const bodyTop = body.getBoundingClientRect().top;
  type Placed = { el: HTMLElement; top: number; blocks: HTMLElement[] };
  const anchored: Placed[] = [];
  const unanchored: HTMLElement[] = [];
  const resolved: HTMLElement[] = [];
  const all = draft ? [...list, draft] : list;
  for (const c of all) {
    const blocks = blocksFor(c);
    const ok = stillMatches(c, blocks);
    const el = card(c, c === draft, ok);
    if (c.status === "resolved" && c !== draft) { resolved.push(el); continue; }
    if (!ok) { unanchored.push(el); continue; }
    anchored.push({ el, top: blocks[0].getBoundingClientRect().top - bodyTop, blocks });
  }
  const inListOrder = [...anchored]; // blockCards keeps the list order
  anchored.sort((a, b) => a.top - b.top);

  // Pass 2: class writes and appends, queueing each box that stacks (wanted 0 = right below the last one).
  const queue: { el: HTMLElement; wanted: number }[] = [];
  const enqueue = (el: HTMLElement, wanted: number) => { margin!.appendChild(el); queue.push({ el, wanted }); };
  for (const p of inListOrder) {
    for (const b of p.blocks) {
      b.classList.add("doc-anchor");
      blockCards.set(b, [...(blockCards.get(b) ?? []), p.el]);
    }
  }
  if (unanchored.length) {
    const head = note(`Unanchored (${unanchored.length})`);
    head.title = "The passage changed since the comment.";
    enqueue(head, 0);
    for (const el of unanchored) { el.classList.add("unanchored"); enqueue(el, 0); }
  }
  for (const p of anchored) {
    if (narrow) {
      // gutter marker at the anchor; the one expanded card floats beside it
      const m = document.createElement("button");
      m.className = "doc-marker";
      m.title = "Show Comment";
      m.style.top = `${p.top}px`;
      const id = p.el.dataset.id!;
      m.addEventListener("click", (e) => { e.stopPropagation(); expandedId = expandedId === id ? null : id; layout(); });
      margin.appendChild(m);
      if (expandedId === id) { p.el.classList.add("popover"); enqueue(p.el, p.top); }
      for (const b of p.blocks) blockCards.set(b, [...(blockCards.get(b) ?? []).filter((x) => x !== p.el), m]);
    } else {
      enqueue(p.el, p.top);
    }
  }
  if (resolved.length) {
    const fold = document.createElement("button");
    fold.className = "doc-fold";
    fold.textContent = `${foldResolved ? "▸" : "▾"} Resolved (${resolved.length})`;
    fold.addEventListener("click", (e) => { e.stopPropagation(); foldResolved = !foldResolved; layout(); });
    enqueue(fold, 0);
    if (!foldResolved) for (const el of resolved) { el.classList.add("resolved"); enqueue(el, 0); }
  }

  // Pass 3: every height in one read pass. Pass 4: cursor math, then the style.top writes.
  const heights = queue.map((q) => q.el.offsetHeight);
  let cursor = 0;
  queue.forEach((q, i) => {
    const y = Math.max(q.wanted, cursor);
    q.el.style.top = `${y}px`;
    cursor = y + heights[i] + GAP;
  });
}

function note(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "doc-margin-note";
  d.textContent = text;
  return d;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function card(c: Comment, editing: boolean, anchoredOk: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = "doc-card";
  el.dataset.id = c.id;
  if (editing) el.classList.add("editing");
  // the highlighted passage already says what the card is about; the quote
  // is shown only when the passage is gone (unanchored) and it's the sole clue
  if (!anchoredOk) {
    const q = document.createElement("div");
    q.className = "quote";
    q.textContent = c.quote;
    el.appendChild(q);
  }
  if (editing) {
    const ta = document.createElement("textarea");
    ta.placeholder = "Comment";
    ta.maxLength = TEXT_MAX;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); commitDraft(ta.value); }
      else if (e.key === "Escape") { e.preventDefault(); discardDraft(); }
    });
    el.appendChild(ta);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.append(btn("Save", () => commitDraft(ta.value)), btn("Cancel", discardDraft));
    el.appendChild(meta);
    return el;
  }
  const t = document.createElement("div");
  t.className = "text";
  t.textContent = c.text;
  el.appendChild(t);
  const meta = document.createElement("div");
  meta.className = "meta";
  const when = document.createElement("span");
  when.textContent = ago(c.atMs);
  when.title = new Date(c.atMs).toLocaleString();
  meta.appendChild(when);
  meta.appendChild(c.status === "open" ? btn("Resolve", () => setStatus(c, "resolved")) : btn("Reopen", () => setStatus(c, "open")));
  meta.appendChild(btn("Delete", () => remove(c)));
  el.appendChild(meta);
  el.addEventListener("mouseenter", () => { for (const [b, cards] of blockCards) if (cards.includes(el)) b.classList.add("doc-anchor-hot"); });
  el.addEventListener("mouseleave", () => { for (const b of root?.querySelectorAll(".doc-anchor-hot") ?? []) b.classList.remove("doc-anchor-hot"); });
  return el;
}

function btn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function hoverBlock(e: MouseEvent, on: boolean) {
  const b = (e.target as Element).closest?.(".doc-anchor");
  if (!b) return;
  for (const c of blockCards.get(b) ?? []) c.classList.toggle("hot", on);
}

/* ---- handoff: one typed line, unsent ---- */

async function requestRevision() {
  const t = target;
  const g = gen;
  const dest = getActiveSessionId(); // captured with the document, before any await
  if (!t || !enabled) return;
  if (!dest) return statusFn("request: no destination terminal");
  const open = list.filter((c) => c.status === "open").length;
  if (!open) return statusFn("request: no open comments");
  const text = `Read the comments in "${t.path}.comments.json" and revise the plan.`;
  if (/[\x00-\x1f\x7f]/.test(text)) return statusFn("request: path has control characters");
  if (new TextEncoder().encode(text).length > REQUEST_MAX_BYTES) return statusFn("request: path too long");
  const ok = await writeToSession(dest, text);
  if (g === gen) statusFn(ok ? "revision request typed — press Enter in the terminal" : "request: target closed");
}
