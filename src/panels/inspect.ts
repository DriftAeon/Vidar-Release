// Inspect mode: hover outlines a UI region, click copies a greppable
// "vidar-ref:" string to paste into a Claude chat. Pure frontend debug layer.

import { iconImg } from "../icon-img";

let active = false;
let btn: HTMLElement;
let box: HTMLElement;
let chip: HTMLElement;
// spacing aids: margin band, scrollbar-gutter band, padding band, gap strips (all fixed, pointer-events none)
let marginBox: HTMLElement;
let gutterBox: HTMLElement;
let padBox: HTMLElement;
let gapLayer: HTMLElement;
const MAX_GAPS = 64;
const AID_IDS = new Set(["inspect-box", "inspect-chip", "inspect-margin", "inspect-gutter", "inspect-pad", "inspect-gaps"]);
// Chip holds a copy-result flash briefly so the next hover doesn't erase it.
let flashUntil = 0;

// click alone isn't enough: dblclick opens rename, contextmenu opens the
// launcher/theme menus, and xterm's right-click handler grabs focus.
const SUPPRESSED = ["click", "mousedown", "contextmenu", "dblclick", "auxclick"] as const;

// Session-strip / bar state classes — never part of a region's identity.
const STATE_CLASSES = new Set(["active", "hidden", "named", "dead"]);

function classSelector(el: Element): string | null {
  const cls = [...el.classList].filter((c) => !STATE_CLASSES.has(c));
  return cls.length ? "." + cls.join(".") : null;
}

interface Region {
  el: Element;
  ref: string;
}

const px = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

// CSS shorthand collapse of top/right/bottom/left.
function collapse(s: number[]): string {
  const [t, r, b, l] = s;
  if (t === r && r === b && b === l) return `${t}`;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

const sides = (cs: CSSStyleDeclaration, pre: string, post = ""): number[] =>
  ["Top", "Right", "Bottom", "Left"].map((s) => px(cs.getPropertyValue(`${pre}-${s.toLowerCase()}${post}`)));

function isGapContainer(cs: CSSStyleDeclaration): boolean {
  return /flex|grid/.test(cs.display);
}

// Scrollbar gutters [left, right, bottom]: track space reserved between the border and the
// padding, neither padding nor margin. `scrollbar-gutter: stable both-edges` splits the
// vertical one across both sides. Only scroll containers (inline boxes report clientWidth 0).
function gutters(el: Element, cs: CSSStyleDeclaration): number[] {
  if (!(el instanceof HTMLElement) || !/auto|scroll/.test(cs.overflowX + cs.overflowY)) return [0, 0, 0];
  const bw = sides(cs, "border", "-width");
  const v = Math.max(0, Math.round(el.offsetWidth - el.clientWidth - bw[1] - bw[3]));
  const b = Math.max(0, Math.round(el.offsetHeight - el.clientHeight - bw[0] - bw[2]));
  const l = cs.scrollbarGutter.includes("both-edges") ? Math.floor(v / 2) : 0;
  return [l, v - l, b];
}

// ` — pad 10 12 0 · gutter 10 · gap 6 · mt 5`: spacing numbers beside the ref, zero groups omitted.
function spacingTail(el: Element): string {
  const cs = getComputedStyle(el);
  const groups: string[] = [];
  const pad = sides(cs, "padding");
  if (pad.some((n) => n)) groups.push(`pad ${collapse(pad)}`);
  const [gl, gr, gb] = gutters(el, cs);
  if (gl && gl === gr) groups.push(`gutter ${gl}`);
  else {
    if (gl) groups.push(`gutter-l ${gl}`);
    if (gr) groups.push(`gutter-r ${gr}`);
  }
  if (gb) groups.push(`gutter-b ${gb}`);
  const bw = sides(cs, "border", "-width");
  if (bw.some((n) => n)) groups.push(`bw ${collapse(bw)}`);
  if (isGapContainer(cs)) {
    const rg = px(cs.rowGap);
    const cg = px(cs.columnGap);
    if (rg || cg) groups.push(rg === cg ? `gap ${rg}` : `gap ${rg} ${cg}`);
  }
  const m = sides(cs, "margin");
  const nz = m.filter((n) => n).length;
  if (nz === 1) {
    const i = m.findIndex((n) => n);
    groups.push(`m${"trbl"[i]} ${m[i]}`);
  } else if (nz > 1) groups.push(`m ${collapse(m)}`);
  return groups.length ? ` — ${groups.join(" · ")}` : "";
}

function resolve(start: Element): Region | null {
  // xterm internals (hundreds of spans) collapse to the session container.
  const term = start.closest<HTMLElement>(".term-container");
  if (term) {
    const id = term.dataset.sessionId ?? "?";
    const title = term.dataset.title ?? "";
    return {
      el: term,
      ref: `vidar-ref: .term-container — session ${id} "${title}"${spacingTail(term)}`,
    };
  }
  let own: Element | null = start;
  while (own && own !== document.body && !own.id && !classSelector(own)) {
    own = own.parentElement;
  }
  if (!own || own === document.body || own === document.documentElement) return null;
  let sel = own.id ? `#${own.id}` : classSelector(own)!;
  if (!own.id) {
    // one id of context makes class-only regions (.macro-btn, .pin-row) unambiguous
    const anchor = own.parentElement?.closest("[id]");
    if (anchor && anchor.id !== "app") sel = `#${anchor.id} ${sel}`;
  }
  const text = (own.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  return { el: own, ref: `vidar-ref: ${sel}${text ? ` — "${text}"` : ""}${spacingTail(own)}` };
}

function placeChip(nearRect: DOMRect | null) {
  const c = chip.getBoundingClientRect();
  let x: number;
  let y: number;
  if (nearRect) {
    x = nearRect.left;
    y = nearRect.bottom + 4;
    // mode starts bottom-right, so below-the-box is often off-screen — flip above
    if (y + c.height > window.innerHeight - 4) y = nearRect.top - c.height - 4;
  } else {
    x = window.innerWidth - c.width - 8;
    y = window.innerHeight - c.height - 38;
  }
  chip.style.left = `${Math.max(4, Math.min(x, window.innerWidth - c.width - 4))}px`;
  chip.style.top = `${Math.max(4, y)}px`;
}

function showChip(text: string, nearRect: DOMRect | null) {
  chip.textContent = text;
  chip.classList.remove("hidden");
  placeChip(nearRect);
}

function hideAids() {
  box.classList.add("hidden");
  marginBox.classList.add("hidden");
  gutterBox.classList.add("hidden");
  padBox.classList.add("hidden");
  gapLayer.classList.add("hidden");
  gapLayer.replaceChildren();
}

function place(
  div: HTMLElement,
  left: number,
  top: number,
  w: number,
  h: number,
  widths: number[],
) {
  div.style.left = `${left}px`;
  div.style.top = `${top}px`;
  div.style.width = `${Math.max(0, w)}px`;
  div.style.height = `${Math.max(0, h)}px`;
  div.style.borderWidth = widths.map((n) => `${Math.max(0, n)}px`).join(" ");
  div.classList.remove("hidden");
}

function addGap(l: number, t: number, w: number, h: number) {
  if (gapLayer.childElementCount >= MAX_GAPS || w < 0.5 || h < 0.5) return;
  const g = document.createElement("div");
  g.className = "inspect-gap";
  g.style.left = `${l}px`;
  g.style.top = `${t}px`;
  g.style.width = `${w}px`;
  g.style.height = `${h}px`;
  gapLayer.append(g);
}

// Space between consecutive visible in-flow children of a flex/grid container.
function paintGaps(el: Element, cs: CSSStyleDeclaration) {
  gapLayer.replaceChildren();
  gapLayer.classList.add("hidden");
  if (!isGapContainer(cs)) return;
  const rg = parseFloat(cs.rowGap) || 0;
  const cg = parseFloat(cs.columnGap) || 0;
  if (rg <= 0 && cg <= 0) return;
  const kids: DOMRect[] = [];
  for (const k of el.children) {
    const kc = getComputedStyle(k);
    if (kc.display === "none" || kc.position === "absolute" || kc.position === "fixed") continue;
    kids.push(k.getBoundingClientRect());
  }
  if (kids.length < 2) return;
  const r = el.getBoundingClientRect();
  const pad = sides(cs, "padding");
  const bw = sides(cs, "border", "-width");
  // content box: the cross-axis span a gap strip covers
  const cl = r.left + bw[3] + pad[3];
  const ct = r.top + bw[0] + pad[0];
  const cw = r.width - bw[1] - bw[3] - pad[1] - pad[3];
  const ch = r.height - bw[0] - bw[2] - pad[0] - pad[2];
  // distinct tracks along one axis: cluster by start, keep the running far edge
  const strips = (start: (b: DOMRect) => number, end: (b: DOMRect) => number) => {
    const sorted = [...kids].sort((a, b) => start(a) - start(b));
    const out: Array<[number, number]> = [];
    let far = end(sorted[0]);
    for (const b of sorted.slice(1)) {
      if (start(b) - far > 0.5) out.push([far, start(b)]);
      far = Math.max(far, end(b));
    }
    return out;
  };
  const cols = () => {
    if (cg > 0) for (const [a, b] of strips((x) => x.left, (x) => x.right)) addGap(a, ct, b - a, ch);
  };
  const rows = () => {
    if (rg > 0) for (const [a, b] of strips((x) => x.top, (x) => x.bottom)) addGap(cl, a, cw, b - a);
  };
  if (cs.display.includes("grid")) {
    cols();
    rows();
  } else if (cs.flexWrap === "nowrap") {
    if (cs.flexDirection.startsWith("column")) rows();
    else cols();
  }
  if (gapLayer.childElementCount) gapLayer.classList.remove("hidden");
}

function paint(region: Region | null) {
  if (!region) {
    hideAids();
    return;
  }
  const r = region.el.getBoundingClientRect();
  box.style.left = `${r.left}px`;
  box.style.top = `${r.top}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
  box.classList.remove("hidden");
  const cs = getComputedStyle(region.el);
  const m = sides(cs, "margin").map((n) => Math.max(0, parseFloat(String(n)) || 0));
  const bw = sides(cs, "border", "-width");
  const pad = sides(cs, "padding");
  place(marginBox, r.left - m[3], r.top - m[0], r.width + m[1] + m[3], r.height + m[0] + m[2], m);
  const [gl, gr, gb] = gutters(region.el, cs);
  // inner edge of the border: the gutter band, then the padding band inside it
  const il = r.left + bw[3];
  const it = r.top + bw[0];
  const iw = r.width - bw[1] - bw[3];
  const ih = r.height - bw[0] - bw[2];
  place(gutterBox, il, it, iw, ih, [0, gr, gb, gl]);
  place(padBox, il + gl, it, iw - gl - gr, ih - gb, pad);
  paintGaps(region.el, cs);
  if (performance.now() >= flashUntil) showChip(region.ref, r);
}

async function copyRef(region: Region) {
  let msg: string;
  try {
    await navigator.clipboard.writeText(region.ref);
    msg = "copied ✓ ";
  } catch {
    // navigator.clipboard is unproven in this WebView2 shell — legacy rescue path
    const ta = document.createElement("textarea");
    ta.value = region.ref;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    msg = ok ? "copied ✓ " : "copy FAILED — ";
  }
  flashUntil = performance.now() + 1500;
  showChip(msg + region.ref, region.el.getBoundingClientRect());
}

// mouseover, not mousemove: fires once per element entry — per-pixel resolution
// over xterm's span soup is pure waste. stopPropagation also keeps motion out
// of xterm's mouse-protocol reporting.
function onHover(e: MouseEvent) {
  e.stopPropagation();
  paint(resolve(e.target as Element));
}

function onSuppressed(e: MouseEvent) {
  // the toggle button must stay clickable to exit the mode
  if ((e.target as Element).closest?.("#inspect-btn")) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.type === "click") {
    const region = resolve(e.target as Element);
    if (region) void copyRef(region);
  }
}

function clearLayout() {
  document.body.classList.remove("inspect-layout");
  for (const el of document.querySelectorAll<HTMLElement>("[data-inspect-hue]")) {
    el.removeAttribute("data-inspect-hue");
    el.style.removeProperty("--inspect-hue");
  }
}

// Random hue per element under #app and visible body-level floating panels;
// stable until toggled off. xterm internals are skipped (container only).
function toggleLayout() {
  if (document.body.classList.contains("inspect-layout")) {
    clearLayout();
    return;
  }
  const tag = (el: Element) => {
    if (AID_IDS.has(el.id) || el.closest(".term-container") !== (el.classList.contains("term-container") ? el : null)) return;
    const h = el as HTMLElement;
    h.setAttribute("data-inspect-hue", "");
    h.style.setProperty("--inspect-hue", String(Math.floor(Math.random() * 360)));
  };
  for (const root of document.body.children) {
    if (root.id !== "app" && (AID_IDS.has(root.id) || root.classList.contains("hidden"))) continue;
    if (!["DIV", "SECTION", "ASIDE", "NAV", "UL", "FORM", "DIALOG", "HEADER", "MAIN"].includes(root.tagName)) continue;
    tag(root);
    for (const el of root.querySelectorAll("*")) tag(el);
  }
  document.body.classList.add("inspect-layout");
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    exit();
    return;
  }
  // no focused-field guard: clicks are suppressed in inspect mode, so focus is
  // wherever it was before (usually xterm's helper textarea) and C must still toggle
  if ((e.key === "c" || e.key === "C") && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    toggleLayout();
  }
}

// The toolbench subscribes here: a tool armed while inspect's capture-phase
// suppression is running would never see its own clicks.
const enterHooks: Array<() => void> = [];

export function onInspectEnter(cb: () => void) {
  enterHooks.push(cb);
}

export function exitInspect() {
  exit();
}

function enter() {
  if (active) return;
  for (const cb of enterHooks) cb();
  // Floating UI whose close paths we're about to starve (bubble-phase
  // listeners / blur) — shut it before suppression starts. The synthetic
  // Escape must fire before our own keydown capture attaches.
  document.getElementById("launcher-menu")?.classList.add("hidden");
  document.getElementById("cas-menu")?.classList.add("hidden");
  document
    .getElementById("rename-input")
    ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  active = true;
  document.body.classList.add("inspect-mode");
  btn.classList.add("active");
  document.addEventListener("mouseover", onHover, true);
  for (const t of SUPPRESSED) document.addEventListener(t, onSuppressed, true);
  document.addEventListener("keydown", onKey, true);
  hideAids();
  flashUntil = 0;
  showChip("inspect: click a region to copy its ref — C toggles layout colours — Esc exits", null);
}

function exit() {
  if (!active) return;
  active = false;
  document.body.classList.remove("inspect-mode");
  btn.classList.remove("active");
  document.removeEventListener("mouseover", onHover, true);
  for (const t of SUPPRESSED) document.removeEventListener(t, onSuppressed, true);
  document.removeEventListener("keydown", onKey, true);
  hideAids();
  clearLayout();
  chip.classList.add("hidden");
}

export function initInspect(button: HTMLElement, signal?: AbortSignal) {
  btn = button;
  btn.replaceChildren(iconImg("inspect")); // replaces the ⌖ text glyph
  box = document.createElement("div");
  box.id = "inspect-box";
  box.className = "hidden";
  chip = document.createElement("div");
  chip.id = "inspect-chip";
  chip.className = "hidden";
  marginBox = document.createElement("div");
  marginBox.id = "inspect-margin";
  marginBox.className = "hidden";
  gutterBox = document.createElement("div");
  gutterBox.id = "inspect-gutter";
  gutterBox.className = "hidden";
  padBox = document.createElement("div");
  padBox.id = "inspect-pad";
  padBox.className = "hidden";
  gapLayer = document.createElement("div");
  gapLayer.id = "inspect-gaps";
  gapLayer.className = "hidden";
  document.body.append(marginBox, gutterBox, padBox, gapLayer, box, chip);
  btn.addEventListener("click", () => (active ? exit() : enter()), { signal });
  // exit() drops the document capture listeners enter() adds.
  signal?.addEventListener("abort", exit);
}
