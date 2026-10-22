// The list: status bands (look 2b) and rows, plus the small DOM pieces the card and fullscreen share
// (icon buttons, the status pill, the field bar). A band whose label is "" draws nothing; an empty key draws
// no key span; an empty status draws no pill, and grouped rows drop the pill since the band names it.
// Rows are focusable (roving tabindex); their Send button shows on hover and :focus-within.
import { lucide, type LucideName } from "../icons";
import { iconImg, type ColorIcon } from "../icon-img";
import type { Selection } from "./filter";
import { groupItems, type Segment } from "./groups";
import type { Field, Item, Tone } from "./types";

export function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** An icon-only button; the tooltip doubles as its accessible name. */
export function iconButton(cls: string, icon: LucideName | { color: ColorIcon }, tip: string, run: () => void): HTMLButtonElement {
  const b = node("button", `br-ib ${cls}`);
  b.type = "button";
  b.title = tip;
  b.setAttribute("aria-label", tip);
  b.appendChild(typeof icon === "string" ? lucide(icon, "icn") : iconImg(icon.color));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

/** Send: the adapter's tooltip when it has one (`Adapter.sendTip`), else "Send"; the accessible name stays "Send". */
export function sendButton(cls: string, tip: string | undefined, run: () => void): HTMLButtonElement {
  const b = iconButton(cls, "message-square-text", "Send", run);
  b.replaceChildren(iconImg("comments"));
  if (tip) b.title = tip;
  return b;
}

export const toneOf =(item: Item): Tone => item.group?.tone ?? "neutral";

/** The tinted status label, or null for an empty status. */
export function pill(item: Item): HTMLElement | null {
  if (!item.status) return null;
  return node("span", `br-pill tone-${toneOf(item)}`, item.status);
}

/** Label/value boxes; empty values are dropped. */
export function fieldBar(fields: Field[], cls = "br-fields"): HTMLElement {
  const bar = node("div", cls);
  for (const f of fields) {
    if (!f.value) continue;
    const box = node("span", "br-fm");
    box.append(node("span", "br-fk", f.label), node("span", `br-fv${f.dim ? " dim" : ""}`, f.value));
    bar.appendChild(box);
  }
  return bar;
}

/** The row's leading slot, or null without a lead. The emoji is remote text: textContent only. */
function lead(item: Item): HTMLElement | null {
  const l = item.lead;
  if (!l) return null;
  const el = node("span", "br-lead");
  el.setAttribute("aria-hidden", "true");
  if ("emoji" in l) el.textContent = l.emoji;
  else if ("glyph" in l) el.appendChild(lucide(l.glyph, l.cls ? `icn ${l.cls}` : "icn"));
  return el;
}

/** The status strip: one pressed-state button per segment, flexed by its count. A segment a filter has
 *  emptied stays (count 0) so the selection can be undone; the host hides when there are no segments. */
export function renderDist(
  host: HTMLElement, segs: Segment[], sel: Selection, toggle: (id: string, v: string) => void, busy: boolean,
): void {
  host.hidden = segs.length === 0;
  const out = segs.map((s) => {
    const b = node("button", `br-dist-seg tone-${s.tone}`);
    b.type = "button";
    const tip = `${s.label} · ${s.n}`;
    b.title = tip;
    b.setAttribute("aria-label", tip);
    b.setAttribute("aria-pressed", String(sel[s.facet.id]?.includes(s.facet.value) ?? false));
    b.style.flexGrow = String(s.n);
    b.disabled = busy;
    b.addEventListener("click", () => toggle(s.facet.id, s.facet.value));
    return b;
  });
  host.replaceChildren(...out);
}

export interface RowOpts {
  /** Link relation shown before the key (fullscreen sections). */
  relation?: string;
  /** The pill is hidden on grouped list rows (the band names the status). */
  showPill: boolean;
  send?: (item: Item) => void;
  /** Send's tooltip (`Adapter.sendTip`). */
  sendTip?: string;
  activate: (item: Item) => void;
}

export function buildRow(item: Item, o: RowOpts): HTMLElement {
  const row = node("div", "br-row");
  row.tabIndex = -1;
  row.dataset.id = item.id;
  if (item.tip) row.title = item.tip;
  row.setAttribute("role", "button");
  if (o.relation) row.appendChild(node("span", "br-rel", o.relation));
  const mark = lead(item);
  if (mark) row.appendChild(mark);
  if (item.key) row.appendChild(node("span", "br-key", item.key));
  row.appendChild(node("span", "br-title", item.title));
  const p = o.showPill ? pill(item) : null;
  if (p) row.appendChild(p);
  if (item.tags?.length) {
    const tags = node("span", "br-tags");
    for (const t of item.tags) tags.appendChild(node("span", `br-pill tone-${t.tone}`, t.label));
    row.appendChild(tags);
  }
  if (o.send) {
    const send = o.send;
    row.appendChild(sendButton("br-send", o.sendTip, () => send(item)));
  }
  row.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    o.activate(item);
  });
  return row;
}

export interface ListHooks {
  activate(item: Item): void;
  send(item: Item): void;
  /** Send's tooltip (`Adapter.sendTip`). */
  sendTip?: string;
  /** The expanded item's card (built on first open). */
  card(item: Item): HTMLElement;
}

/** Fills `host` with bands and rows; returns the rows in visual order. */
export function renderList(host: HTMLElement, items: Item[], expanded: string | null, h: ListHooks): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const out: HTMLElement[] = [];
  for (const band of groupItems(items)) {
    // A labelled band is a card (head plus rows) carrying its id and tone for the edge colour; ungrouped rows stay flat.
    // Its class is br-group: br-sec is the fullscreen section head (full.ts, browser-full.css: 24px tall).
    if (band.label !== "") {
      const sec = node("div", "br-group");
      sec.dataset.band = band.id;
      sec.dataset.tone = band.tone;
      const head = node("div", `br-band tone-${band.tone}`);
      head.append(node("span", "br-band-label", band.label));
      sec.append(head);
      out.push(sec);
      for (const item of band.items) sec.append(...buildItem(item));
      continue;
    }
    for (const item of band.items) out.push(...buildItem(item));
  }
  function buildItem(item: Item): HTMLElement[] {
    const row = buildRow(item, { showPill: !item.group, send: h.send, sendTip: h.sendTip, activate: h.activate });
    rows.push(row);
    const open = item.id === expanded;
    row.setAttribute("aria-expanded", String(open));
    if (!open) return [row];
    row.classList.add("open");
    return [row, h.card(item)];
  }
  host.replaceChildren(...out);
  return rows;
}
