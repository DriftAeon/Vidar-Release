// The filter row (look 1a): a Search field, one chip per top facet, and More for the rest. An idle chip is
// outline only; an active one shows its value (one chosen) or label and count (two or more), plus a clear X.
// More's badge counts its active facets. Each chip opens a checkbox menu with per-value counts; More lists
// its facets, each opening a side list, then Clear Filters. Search is debounced 100 ms.
import { lucide } from "../icons";
import { AGE_BUCKETS, type Selection } from "./filter";
import { node } from "./list";
import type { MenuHost } from "./menu";
import type { Facet } from "./types";

export interface ChipState {
  facets: Facet[];
  sel: Selection;
  counts: Record<string, Map<string, number>>;
}

export interface ChipHooks {
  menus: MenuHost;
  onQuery(q: string): void;
  toggle(facetId: string, value: string): void;
  clear(facetId: string): void;
  clearAll(): void;
}

export interface FilterRow {
  el: HTMLElement;
  search: HTMLInputElement;
  update(s: ChipState): void;
  /** Redraws the chips with the last state (a menu closed). */
  refresh(): void;
  /** Sets the field without firing onQuery (Clear Filters). */
  setQuery(q: string): void;
  dispose(): void;
}

export const SEARCH_DEBOUNCE_MS = 100;

/** The visible label of one value. Age facets use the shared bucket labels. */
export function valueText(f: Facet, v: string): string {
  if (f.kind === "age") return AGE_BUCKETS.find((b) => b.id === v)?.label ?? v;
  return f.valueLabel(v);
}

/** Values in menu order: age buckets in their fixed order, other facets by label. */
export function valuesOf(f: Facet, counts: Map<string, number> | undefined): string[] {
  const have = [...(counts?.keys() ?? [])];
  if (f.kind === "age") return AGE_BUCKETS.map((b) => b.id as string).filter((id) => have.includes(id));
  return have.sort((a, b) => valueText(f, a).localeCompare(valueText(f, b)));
}

function valueItem(f: Facet, v: string, s: ChipState, toggle: ChipHooks["toggle"]): HTMLButtonElement {
  const on = (s.sel[f.id] ?? []).includes(v);
  const b = node("button", "br-mi");
  b.type = "button";
  b.setAttribute("role", "menuitemcheckbox");
  b.setAttribute("aria-checked", String(on));
  b.dataset.value = v;
  const box = node("span", `br-box${on ? " on" : ""}`);
  if (on) box.appendChild(lucide("check", "icn"));
  b.append(box, node("span", "br-mi-label", valueText(f, v)), node("span", "br-mi-n", String(s.counts[f.id]?.get(v) ?? 0)));
  b.addEventListener("click", () => toggle(f.id, v));
  return b;
}

function buildValues(m: HTMLDivElement, f: Facet, s: ChipState, toggle: ChipHooks["toggle"]): void {
  for (const v of valuesOf(f, s.counts[f.id])) m.appendChild(valueItem(f, v, s, toggle));
}

export function buildFilterRow(h: ChipHooks): FilterRow {
  const el = node("div", "br-filters");
  const box = node("label", "br-search");
  box.appendChild(lucide("search", "icn"));
  const search = node("input", "br-search-q");
  search.type = "search";
  search.setAttribute("aria-label", "Search");
  search.spellcheck = false;
  box.appendChild(search);
  const chips = node("div", "br-chips");
  el.append(box, chips);

  let timer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener("input", () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; h.onQuery(search.value); }, SEARCH_DEBOUNCE_MS);
  });

  let state: ChipState = { facets: [], sel: {}, counts: {} };
  /** Facet id (or "\u0000more") of the chip whose menu is open; kept across re-renders. */
  let openId: string | null = null;
  const MORE = "\u0000more";

  const facetById = (id: string) => state.facets.find((f) => f.id === id);

  function openFacet(btn: HTMLElement, id: string): void {
    const f = facetById(id);
    if (!f) return;
    openId = id;
    h.menus.open(btn, el, (m) => { const cur = facetById(id); if (cur) buildValues(m, cur, state, h.toggle); }, f.label);
    sync();
  }

  function buildMore(m: HTMLDivElement): void {
    for (const f of state.facets.filter((x) => x.place === "more")) {
      const chosen = state.sel[f.id] ?? [];
      const b = node("button", "br-mi br-mi-sub");
      b.type = "button";
      b.dataset.sub = f.id;
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
      const v = chosen.length === 0 ? "Any" : chosen.length === 1 ? valueText(f, chosen[0]) : String(chosen.length);
      b.append(node("span", "br-mi-label", f.label), node("span", `br-mi-v${chosen.length ? " on" : ""}`, v));
      b.addEventListener("click", () => {
        h.menus.openSide(b, (side) => { const cur = facetById(f.id); if (cur) buildValues(side, cur, state, h.toggle); }, f.label);
      });
      m.appendChild(b);
    }
    m.appendChild(node("div", "br-sep"));
    const clear = node("button", "br-mi br-mi-clear", "Clear Filters");
    clear.type = "button";
    clear.addEventListener("click", () => { h.menus.close(true); h.clearAll(); });
    m.appendChild(clear);
  }

  function chip(id: string, label: string, chosen: string[], f: Facet | null): HTMLElement {
    const wrap = node("span", "br-chip");
    const on = chosen.length > 0;
    const isOpen = openId === id && h.menus.isOpen();
    wrap.classList.toggle("br-chip-more", f === null);
    wrap.classList.toggle("on", on);
    wrap.classList.toggle("open", isOpen);
    const b = node("button", "br-chip-btn");
    b.type = "button";
    b.dataset.facet = id;
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", String(isOpen));
    if (f && chosen.length === 1) b.appendChild(node("span", "br-chip-label", valueText(f, chosen[0])));
    else {
      b.appendChild(node("span", "br-chip-label", label));
      if (chosen.length > 1 || (!f && on)) b.appendChild(node("span", "br-chip-n", String(chosen.length)));
    }
    if (!on || !f) b.appendChild(lucide("chevron-down", "icn"));
    b.addEventListener("click", () => {
      if (isOpenFor(id)) { h.menus.close(true); return; }
      if (f) openFacet(b, id);
      else {
        openId = MORE;
        h.menus.open(b, el, buildMore, "More");
        sync();
      }
    });
    wrap.appendChild(b);
    if (on && f) {
      const x = node("button", "br-chip-x");
      x.type = "button";
      x.title = "Clear";
      x.setAttribute("aria-label", `Clear ${label}`);
      x.appendChild(lucide("x", "icn"));
      x.addEventListener("click", () => h.clear(id));
      wrap.appendChild(x);
    }
    return wrap;
  }

  const isOpenFor = (id: string) => openId === id && h.menus.isOpen();

  function sync(): void {
    if (!h.menus.isOpen()) openId = null;
    const focusedFacet = (document.activeElement as HTMLElement | null)?.closest?.(".br-chips") === chips
      ? (document.activeElement as HTMLElement).dataset.facet : undefined;
    chips.replaceChildren();
    for (const f of state.facets.filter((x) => x.place === "top")) chips.appendChild(chip(f.id, f.label, state.sel[f.id] ?? [], f));
    const more = state.facets.filter((x) => x.place === "more");
    if (more.length) {
      const active = more.filter((f) => (state.sel[f.id] ?? []).length > 0).map((f) => f.id);
      chips.appendChild(chip(MORE, "More", active, null));
    }
    // a re-render replaced the chip that opened the menu: point the menu's anchor at its new button
    if (openId !== null) {
      const btn = [...chips.querySelectorAll<HTMLElement>(".br-chip-btn")].find((b) => b.dataset.facet === openId);
      if (btn) h.menus.setAnchor(btn);
    }
    if (focusedFacet) [...chips.querySelectorAll<HTMLElement>(".br-chip-btn")].find((b) => b.dataset.facet === focusedFacet)?.focus();
  }

  return {
    el,
    search,
    update(s) {
      state = s;
      sync();
    },
    refresh: () => sync(),
    setQuery(q) {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      search.value = q;
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
