// The shared browser shell (docs/projects/notion/plan.md § Shell interface): the adapter's head, the filter
// row, the grouped list with one inline card, and fullscreen. Source-agnostic: everything about a source
// comes through the Adapter. Filters persist per `adapter.source` under `browser.filters`, read through
// `cleanFilters`, written through `writeSource` then `cleanFilters`.
import { getPref, setPref } from "../prefs";
import { buildCard } from "./card";
import { buildFilterRow } from "./chips";
import { cleanFilters, facetCounts, filterItems, writeSource, type Selection } from "./filter";
import { buildFull, type FullView } from "./full";
import { attachKeys, focusRow } from "./keys";
import { segments } from "./groups";
import { node, renderDist, renderList } from "./list";
import { menuHost } from "./menu";
import type { Adapter, Browser, Facet, Item, RenderCtx } from "./types";
import { parseWhen } from "./when";

const NO_CHILDREN = { error: { title: "No Child Blocks", message: "This source has no child blocks." } } as const;

function readSelection(source: string): Selection {
  return cleanFilters(getPref("browser.filters"))[source] ?? {};
}

function writeSelection(source: string, sel: Selection): void {
  const next = cleanFilters(writeSource(cleanFilters(getPref("browser.filters")), source, sel));
  setPref("browser.filters", next);
}

export function buildBrowser(adapter: Adapter, head: HTMLElement): Browser {
  const root = node("div", "br-root");
  head.classList.add("br-head");

  let items: Item[] = [];
  let facets: Facet[] = [];
  let busy = false;
  let note: string | null = null;
  let sel: Selection = readSelection(adapter.source);
  let query = "";
  let expanded: string | null = null;
  let rows: HTMLElement[] = [];
  let disposed = false;
  /** Bumped when the fullscreen item changes or closes, and on dispose; a RenderCtx is alive while it matches. */
  let gen = 0;
  let full: { item: Item; view: FullView } | null = null;
  let listScroll = 0;
  const cards = new Map<string, { item: Item; el: HTMLElement }>();

  const menus = menuHost(() => filters.refresh());
  /** Toggles one facet value; the chips and the status strip share it. */
  const toggleValue = (id: string, v: string): void => {
    const cur = sel[id] ?? [];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    const copy = { ...sel };
    if (next.length) copy[id] = next;
    else delete copy[id];
    setSelection(copy);
  };
  const filters = buildFilterRow({
    menus,
    onQuery: (q) => { query = q; render(); },
    toggle: toggleValue,
    clear: (id) => {
      const copy = { ...sel };
      delete copy[id];
      setSelection(copy);
    },
    clearAll: () => clearAll(),
  });
  const distEl = node("div", "br-dist");
  distEl.hidden = true;
  const list = node("div", "br-list");
  const empty = node("div", "br-empty");
  const noteEl = node("div", "br-note");
  const fullHost = node("div", "br-full-host");
  fullHost.hidden = true;
  root.append(head, filters.el, distEl, list, empty, noteEl, fullHost);

  function setSelection(next: Selection): void {
    sel = next;
    writeSelection(adapter.source, sel);
    render();
  }

  function clearAll(): void {
    query = "";
    filters.setQuery("");
    setSelection({});
  }

  function card(item: Item): HTMLElement {
    const hit = cards.get(item.id);
    if (hit && hit.item.updated === item.updated) return hit.el;
    const entry = { item, el: null as unknown as HTMLElement };
    entry.el = buildCard(adapter, item, {
      fullscreen: (it) => openFull(it),
      alive: () => !disposed && cards.get(item.id) === entry,
    });
    cards.set(item.id, entry);
    return entry.el;
  }

  function activate(item: Item): void {
    if (adapter.activate?.(item)) return;
    expanded = expanded === item.id ? null : item.id;
    render();
    focusRow(rows, rows.find((r) => r.dataset.id === item.id));
  }

  function render(): void {
    if (disposed) return;
    const env = { now: Date.now(), parse: parseWhen };
    const shown = filterItems(items, facets, sel, query, env);
    filters.el.hidden = items.length === 0;
    filters.update({ facets, sel, counts: facetCounts(items, facets, sel, query, env) });
    renderDist(distEl, segments(items, shown), sel, toggleValue, busy);
    const ids = new Set(items.map((i) => i.id));
    for (const id of [...cards.keys()]) if (!ids.has(id)) cards.delete(id);
    if (expanded !== null && !shown.some((i) => i.id === expanded)) expanded = null;
    const focused = (document.activeElement as HTMLElement | null)?.closest?.(".br-row") as HTMLElement | null;
    const focusId = focused && list.contains(focused) ? focused.dataset.id : undefined;
    rows = renderList(list, shown, expanded, { activate, send: (it) => adapter.send(it), sendTip: adapter.sendTip, card });
    const keep = rows.find((r) => r.dataset.id === focusId);
    if (keep) focusRow(rows, keep);
    else if (rows[0]) rows[0].tabIndex = 0;
    empty.replaceChildren();
    empty.hidden = !(shown.length === 0 && items.length > 0);
    if (!empty.hidden) {
      const clear = node("button", "br-link", "Clear Filters");
      clear.type = "button";
      clear.addEventListener("click", () => clearAll());
      empty.append(node("span", "br-empty-title", `No ${adapter.noun} Match`), clear);
    }
    noteEl.textContent = note ?? "";
    noteEl.hidden = !note;
    root.setAttribute("aria-busy", String(busy));
    menus.rerender();
  }

  function ctxFor(): RenderCtx {
    const mine = gen;
    const source = (): number => adapter.generation?.() ?? 0;
    const sourceGen = source();
    const load = adapter.loadChildren;
    return {
      openUrl: (url) => adapter.openUrl(url),
      loadChildren: load ? (id, cursor) => load.call(adapter, id, cursor) : () => Promise.resolve(NO_CHILDREN),
      alive: () => !disposed && gen === mine && source() === sourceGen,
    };
  }

  function showList(on: boolean): void {
    for (const el of [head, filters.el, distEl, list, empty, noteEl]) el.classList.toggle("br-off", !on);
    fullHost.hidden = on;
  }

  function openFull(item: Item): void {
    if (disposed) return;
    menus.close();
    if (!full) listScroll = list.scrollTop;
    gen++;
    const view = buildFull(adapter, item, {
      back: () => closeFull(),
      open: (it) => { if (!adapter.activate?.(it)) openFull(it); },
      ctx: ctxFor(),
    });
    full = { item, view };
    fullHost.replaceChildren(view.el);
    showList(false);
    view.el.focus();
  }

  function closeFull(): void {
    if (!full) return;
    gen++;
    full = null;
    fullHost.replaceChildren();
    showList(true);
    list.scrollTop = listScroll;
    focusRow(rows, rows.find((r) => r.dataset.id === expanded) ?? rows[0]);
  }

  function escape(): boolean {
    if (menus.close(true)) return true;
    if (full) { closeFull(); return true; }
    if (expanded !== null) {
      const id = expanded;
      expanded = null;
      render();
      focusRow(rows, rows.find((r) => r.dataset.id === id));
      return true;
    }
    if (adapter.back) { adapter.back(); return true; }
    return false;
  }

  const detachKeys = attachKeys(root, {
    rows: () => (full ? full.view.rows() : rows),
    activate: (row) => {
      // a section row's own click handler replaces the page
      if (full) { if (full.view.rows().includes(row)) row.click(); return; }
      const item = items.find((i) => i.id === row.dataset.id);
      if (item) activate(item);
    },
    escape,
  });

  // The root resizing or going to zero size (module hidden, bench tab switched) closes any open menu.
  const ro = new ResizeObserver(() => { menus.close(); });
  ro.observe(root);

  render();

  return {
    root,
    setItems(next, nextFacets, s) {
      if (disposed) return;
      items = next;
      facets = nextFacets;
      busy = s.busy;
      note = s.note;
      render();
    },
    reset() {
      if (disposed) return;
      menus.close();
      if (full) { // closeFull without moving focus: the user is on Disconnect or the form
        full = null;
        fullHost.replaceChildren();
        showList(true);
      }
      gen++; // ends every RenderCtx
      listScroll = 0;
      expanded = null;
      cards.clear();
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gen++;
      menus.dispose();
      filters.dispose();
      ro.disconnect();
      detachKeys();
      cards.clear();
    },
  };
}
