// Jira bench filter bar (plan D6): Project, Type, Status, Assignee pickers, a Search box and Clear Filters.
// The panel owns the filter state and the reloads; this file draws the bar and its popovers (fixed on body,
// so the pane's overflow cannot clip them) and reports each change. Remote text goes in through textContent.
import { lucide } from "../icons";
import {
  ASSIGNEES, CATEGORIES, MAX_PICKS, MAX_TEXT, applicable, barShape, blankFilters, filtersSet, togglePick, typeIcon,
  type FilterState, type Scope,
} from "./model";
import { renderTypeIcon } from "./type-icon";

/** One option list: not yet loaded, loaded, or failed on its own. */
export interface Opt<T> { status: "loading" | "ready" | "failed"; items: T[] }

export interface BarState {
  scope: Scope;
  blankJql: boolean;
  filters: FilterState;
  types: Opt<{ name: string; level: number }>;
  projects: Opt<{ key: string; name: string }>;
}

export interface BarHandlers {
  /** `typing` is true for a keystroke in Search (the panel debounces it); every other change reloads at once. */
  change(next: FilterState, typing: boolean): void;
}

export interface FilterBar {
  root: HTMLElement;
  render(state: BarState): void;
  close(): void;
}

type Kind = "project" | "type" | "status" | "assignee";

interface Item { id: string; label: string; mono?: string; icon?: Node; on: boolean; locked: boolean }

export const LIST_FAILED = "Couldn't load this list from Jira.";
export const STATUS_NARROWS = "Narrows your saved query; it can't add statuses the query leaves out.";
const LABELS: Record<Kind, string> = { project: "Project", type: "Type", status: "Status", assignee: "Assignee" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

export function buildFilterBar(h: BarHandlers): FilterBar {
  const root = el("div", "jx-filters wb-actions");
  root.hidden = true;
  let cur: BarState | null = null;
  let open: Kind | null = null;
  let pop: HTMLElement | null = null;
  let popOff: (() => void) | null = null;

  const picks = {} as Record<Kind, { btn: HTMLButtonElement; n: HTMLElement }>;
  for (const kind of ["project", "type", "status", "assignee"] as Kind[]) {
    const btn = el("button", "jx-pick wb-card-btn");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "menu");
    const label = el("span", "jx-pick-label");
    label.textContent = LABELS[kind];
    const n = el("span", "jx-n");
    n.hidden = true;
    btn.append(label, n);
    btn.addEventListener("click", () => (open === kind ? close() : openPop(kind, btn)));
    picks[kind] = { btn, n };
    root.append(btn);
  }

  const search = el("label", "jx-search");
  const input = el("input", "jx-search-in");
  input.type = "text";
  input.placeholder = "Search";
  input.setAttribute("aria-label", "Search");
  input.maxLength = MAX_TEXT;
  input.spellcheck = false;
  input.autocomplete = "off";
  search.append(lucide("search"), input);
  input.addEventListener("input", () => {
    if (!cur) return;
    const text = input.value.slice(0, MAX_TEXT);
    h.change({ ...cur.filters, text }, true);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !cur) return;
    e.preventDefault();
    h.change({ ...cur.filters, text: input.value.slice(0, MAX_TEXT) }, false);
  });

  const clear = el("button", "jx-link");
  clear.type = "button";
  clear.textContent = "Clear Filters";
  clear.addEventListener("click", () => { close(); h.change(blankFilters(), false); });
  root.append(search, clear);

  function itemsFor(kind: Kind, s: BarState): Item[] {
    const f = s.filters;
    if (kind === "type") {
      return s.types.items.map((t) => ({
        id: t.name, label: t.name, icon: renderTypeIcon(typeIcon(t.level, t.name)), on: f.types.includes(t.name),
        locked: !f.types.includes(t.name) && f.types.length >= MAX_PICKS,
      }));
    }
    if (kind === "project") {
      return s.projects.items.map((p) => ({
        id: p.key, label: p.name, mono: p.key, on: f.projects.includes(p.key),
        locked: !f.projects.includes(p.key) && f.projects.length >= MAX_PICKS,
      }));
    }
    if (kind === "status") {
      return CATEGORIES.map(([id, label]) => ({ id: String(id), label, on: f.categories.includes(id), locked: false }));
    }
    return ASSIGNEES.map(([id, label]) => ({ id, label, on: f.assignee === id, locked: false }));
  }

  function choose(kind: Kind, id: string) {
    if (!cur) return;
    const f = cur.filters;
    if (kind === "type") h.change({ ...f, types: togglePick(f.types, id) }, false);
    else if (kind === "project") h.change({ ...f, projects: togglePick(f.projects, id) }, false);
    else if (kind === "status") h.change({ ...f, categories: togglePick(f.categories, Number(id)) }, false);
    else {
      close();
      h.change({ ...f, assignee: id as FilterState["assignee"] }, false);
    }
  }

  function fillPop(kind: Kind, s: BarState) {
    if (!pop) return;
    const focused = pop.contains(document.activeElement) ? [...pop.children].indexOf(document.activeElement as Element) : -1;
    pop.replaceChildren();
    const multi = kind !== "assignee";
    for (const item of itemsFor(kind, s)) {
      const b = el("button", "cx-menu-item jx-opt");
      b.type = "button";
      b.setAttribute("role", multi ? "menuitemcheckbox" : "menuitemradio");
      b.setAttribute("aria-checked", String(item.on));
      b.disabled = item.locked;
      if (multi) {
        const box = el("span", item.on ? "jx-box on" : "jx-box");
        if (item.on) box.append(lucide("check"));
        b.append(box);
      }
      if (item.icon) {
        const ty = el("span", "ty");
        ty.append(item.icon);
        b.append(ty);
      }
      if (item.mono) {
        const key = el("span", "jx-opt-key");
        key.textContent = item.mono;
        b.append(key);
      }
      const label = el("span", "jx-opt-label");
      label.textContent = item.label;
      b.append(label);
      if (!multi && item.on) b.classList.add("on");
      b.addEventListener("click", () => choose(kind, item.id));
      pop.append(b);
    }
    if (focused >= 0) (pop.children[focused] as HTMLElement | undefined)?.focus();
  }

  function place(anchor: HTMLElement) {
    if (!pop) return;
    // the gap is measured from the bar's bottom edge, not the picker's
    const bar = root.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    pop.style.top = `${bar.bottom + 4}px`;
    pop.style.left = `${Math.max(4, a.left)}px`;
  }

  function openPop(kind: Kind, anchor: HTMLElement) {
    if (!cur) return;
    close();
    open = kind;
    pop = el("div", "cx-menu jx-pop");
    pop.setAttribute("role", "menu");
    pop.setAttribute("aria-label", LABELS[kind]);
    document.body.append(pop);
    fillPop(kind, cur);
    place(anchor);
    anchor.setAttribute("aria-expanded", "true");
    anchor.classList.add("open");
    const p = pop;
    const onDown = (e: PointerEvent) => {
      if (!p.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(); anchor.focus(); }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    popOff = () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    (p.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus();
  }

  function close() {
    if (open) {
      picks[open].btn.removeAttribute("aria-expanded");
      picks[open].btn.classList.remove("open");
    }
    open = null;
    pop?.remove();
    pop = null;
    popOff?.();
    popOff = null;
  }

  function render(s: BarState) {
    cur = s;
    const shape = barShape(s.scope, s.blankJql);
    const f = s.filters;
    picks.project.btn.hidden = !shape.project;
    picks.assignee.btn.hidden = !shape.assignee;
    const lists: Partial<Record<Kind, Opt<unknown>>> = { project: s.projects, type: s.types };
    const counts: Record<Kind, string> = {
      project: f.projects.length ? String(f.projects.length) : "",
      type: f.types.length ? String(f.types.length) : "",
      status: f.categories.length ? String(f.categories.length) : "",
      assignee: f.assignee === "any" ? "" : ASSIGNEES.find(([id]) => id === f.assignee)?.[1] ?? "",
    };
    for (const kind of ["project", "type", "status", "assignee"] as Kind[]) {
      const { btn, n } = picks[kind];
      const list = lists[kind];
      const failed = list?.status === "failed";
      const loading = list?.status === "loading";
      btn.disabled = failed || loading;
      if (loading) btn.setAttribute("aria-busy", "true"); else btn.removeAttribute("aria-busy");
      btn.title = failed ? LIST_FAILED : kind === "status" && s.scope === "mine" && !s.blankJql ? STATUS_NARROWS : "";
      n.textContent = counts[kind];
      n.hidden = !counts[kind];
      btn.classList.toggle("set", !!counts[kind]);
    }
    if (input.value !== f.text) input.value = f.text;
    clear.disabled = !filtersSet(applicable(f, s.scope, s.blankJql));
    if (open && (picks[open].btn.hidden || picks[open].btn.disabled)) close();
    else if (open) fillPop(open, s);
  }

  return { root, render, close };
}
