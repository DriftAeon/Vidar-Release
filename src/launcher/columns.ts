// src\launcher\columns.ts — the launcher's flyout columns: creation, open, placement, hide. Split
// from menu.ts; the root menu element arrives once through setColumnRoot (called by
// initLauncherMenu), so this module never imports menu.ts.
import { colKeydown, kbNav } from "./keyboard";

let root: HTMLElement | null = null;
/** Registered once by initLauncherMenu with the root launcher menu element. */
export function setColumnRoot(el: HTMLElement): void {
  root = el;
}

// Flyout columns: 0 = locations, 1 = bodies (Raw / Rendered / Resume), 2 = recent
// sessions. One class, created on demand, each positioned off the previous
// column — every level is a popout beside its parent, like Claude › locations
// (no duplicate ids, inherit the flip).
export const launcherCols: HTMLElement[] = [];

// Hover intent: moving from an open row to a sibling waits HOVER_SWITCH_MS, so a diagonal
// glide toward the open flyout does not flip it. One pending switch for the whole launcher.
export const HOVER_SWITCH_MS = 150;
let pending: { row: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;
function clearPending(): void {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}
function schedule(row: HTMLElement, run: () => void): void {
  clearPending();
  const timer = setTimeout(() => {
    pending = null;
    if (row.isConnected && !row.closest(".hidden") && !kbNav) run();
  }, HOVER_SWITCH_MS);
  pending = { row, timer };
  row.addEventListener("mouseleave", () => { if (pending?.row === row) clearPending(); }, { once: true });
}
const hasOpenSibling = (row: HTMLElement): boolean =>
  [...(row.parentElement?.children ?? [])].some((s) => s !== row && s.classList.contains("open"));

/** Hover opens the flyout `depth` beside `row`; clicks and keys call `open` themselves, unguarded. */
export function hoverOpen(row: HTMLElement, depth: number, open: () => void): void {
  row.addEventListener("mouseenter", () => {
    if (kbNav) return;
    if (row.classList.contains("open") && !col(depth).classList.contains("hidden")) return;
    if (!hasOpenSibling(row)) {
      clearPending();
      open();
    } else if (pending?.row !== row) schedule(row, open);
  });
}

export function col(depth: number): HTMLElement {
  while (launcherCols.length <= depth) {
    const d = document.createElement("div");
    d.className = "launcher-col hidden";
    d.dataset.depth = String(launcherCols.length);
    d.addEventListener("keydown", colKeydown);
    // hovering a leaf row (Raw, Rendered, a shell location…) closes whatever a
    // sibling had opened beside it, as a menu does; has-sub rows open their own
    const depth = launcherCols.length;
    d.addEventListener("mouseover", (e) => {
      if (kbNav) return;
      const row = (e.target as HTMLElement).closest<HTMLElement>("button");
      if (!row || row.parentElement !== d || row.classList.contains("has-sub")) return;
      const close = () => {
        hideColsFrom(depth + 1);
        for (const c of d.children) c.classList.remove("open");
      };
      if (!hasOpenSibling(row)) close();
      else if (pending?.row !== row) schedule(row, close);
    });
    document.body.appendChild(d);
    launcherCols.push(d);
  }
  return launcherCols[depth];
}
// column -> the anchor it was placed for; a column keeps the side it first opened on
const placedFor = new WeakMap<HTMLElement, HTMLElement>();
export function hideColsFrom(depth: number) {
  if (depth === 0) clearPending();
  for (let i = depth; i < launcherCols.length; i++) {
    launcherCols[i].classList.add("hidden");
    launcherCols[i].innerHTML = "";
    placedFor.delete(launcherCols[i]);
  }
}
/** empty column `depth` (and everything deeper), mark `anchor` open in its parent, return it */
export function openColumn(depth: number, anchor: HTMLElement): HTMLElement {
  const parent = depth === 0 ? root! : col(depth - 1);
  for (const c of parent.children) c.classList.toggle("open", c === anchor);
  hideColsFrom(depth);
  return col(depth);
}
export function placeColumn(depth: number, anchor: HTMLElement) {
  const c = col(depth);
  c.classList.remove("hidden"); // unhidden before measuring, or offsetWidth reads 0
  const prev = depth === 0 ? root! : col(depth - 1);
  const p = prev.getBoundingClientRect();
  const r = anchor.getBoundingClientRect();
  // right of the previous column, top-aligned with the row. Once a column has
  // flipped left, deeper ones keep going left so none covers an ancestor.
  const locked = placedFor.get(c) === anchor && c.dataset.flipped !== undefined;
  const goLeft = locked
    ? c.dataset.flipped === "1"
    : prev.dataset.flipped === "1" || p.right + 4 + c.offsetWidth > window.innerWidth - 8;
  placedFor.set(c, anchor);
  let left = goLeft ? p.left - c.offsetWidth - 4 : p.right + 4;
  if (locked) left = Math.min(left, window.innerWidth - c.offsetWidth - 8); // same side, clamped: a re-place never flips
  else if (left < 8) left = Math.min(p.right + 4, window.innerWidth - c.offsetWidth - 8); // no room either side: best effort
  c.dataset.flipped = goLeft ? "1" : "0";
  c.style.left = `${Math.max(8, left)}px`;
  const top = Math.min(r.top - 4, window.innerHeight - c.offsetHeight - 8);
  c.style.top = `${Math.max(8, top)}px`;
}
