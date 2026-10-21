/** src\panels\reorder.ts — drag-to-reorder for collapsible `.rack-row` lists (Loadout, MCP
 *  servers), order kept in prefs per list (vidar-state.json).
 *  Rows opt in with `data-key`; keyed rows must sit contiguously in the list (trailing notes and
 *  empty-state lines stay unkeyed and unmoved). A press still toggles at once (press.ts); a
 *  press that moves past DRAG_PX becomes a drag and undoes that toggle. */
import { repeatPress } from "./press";
import { getPref, setPref } from "../prefs";
import { mergeVisibleOrder } from "../modules/order";

const DRAG_PX = 5;

export type OrderKey = "order.loadout" | "order.rack" | "order.launcher" | "order.documentFolders" | "order.workbenchTabs" | "order.tools";

/** `handle`: the keyed rows are themselves the grab target (a direct child of the list matching this
 *  selector) and a press has no toggle to undo; absent = `.rack-name` inside a `.rack-row`.
 *  `onStart` runs once when a press becomes a drag. `axis`: "x" for a horizontal strip (default "y"). */
export interface ReorderOpts { handle?: string; onStart?: () => void; axis?: "x" | "y"; visible?: (row: HTMLElement) => boolean }

// Keep the first saved occurrence; later copies cannot claim another slot.
function saved(storeKey: OrderKey): string[] {
  return [...new Set(getPref(storeKey) ?? [])];
}

const keyedRows = (list: HTMLElement) =>
  [...list.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.key);

/** Put the keyed rows in their saved order; a key not in the saved list lands right after the
 *  nearest row before it in the built order that is saved (none: after all known ones). */
export function applyOrder(list: HTMLElement, storeKey: OrderKey): void {
  const rows = keyedRows(list);
  const order = saved(storeKey);
  if (order.length !== (getPref(storeKey) ?? []).length && setPref(storeKey, order)) {
    document.dispatchEvent(new document.defaultView!.CustomEvent("vidar-modules-change"));
  }
  if (rows.length < 2) return;
  const rankOf = new Map<HTMLElement, number>();
  let prev = -1; // saved index of the last known row seen in built order
  for (const r of rows) {
    const i = order.indexOf(r.dataset.key!);
    if (i >= 0) prev = i;
    rankOf.set(r, i >= 0 ? i : prev >= 0 ? prev + 0.5 : order.length);
  }
  const rank = (r: HTMLElement) => rankOf.get(r)!;
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
  const marker = document.createComment("");
  list.insertBefore(marker, rows[0]);
  for (const r of sorted) list.insertBefore(r, marker);
  marker.remove();
}

/** Save visible order while retaining the slot after each available predecessor for absent keys. */
function saveOrder(list: HTMLElement, storeKey: OrderKey, visible?: (row: HTMLElement) => boolean): void {
  const rows = keyedRows(list).filter((row) => !visible || visible(row));
  const next = mergeVisibleOrder(saved(storeKey), rows.map((r) => r.dataset.key!));
  setPref(storeKey, next);
  document.dispatchEvent(new document.defaultView!.CustomEvent("vidar-modules-change"));
}

/** Move one available row by one position for keyboard order controls. */
export function moveOrder(list: HTMLElement, storeKey: OrderKey, key: string, direction: -1 | 1): boolean {
  const rows = keyedRows(list);
  const index = rows.findIndex((row) => row.dataset.key === key);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= rows.length) return false;
  const row = rows[index];
  list.insertBefore(row, direction < 0 ? rows[target] : rows[target].nextSibling);
  saveOrder(list, storeKey);
  return true;
}

/** Wire dragging once per list element. Saving merges with keys not currently shown (a row
 *  absent from this tab, like Launch on a plain Claude tab, keeps its saved slot). */
export function enableReorder(list: HTMLElement, storeKey: OrderKey, opts: ReorderOpts = {}): void {
  let row: HTMLElement | null = null;
  let startY = 0;
  const horiz = opts.axis === "x";
  let dragging = false;
  let suppressClickUntil = 0;

  // A press pending on a row must end on every release path, not only a pointerup the list
  // sees: a release off the list left `row` set and the next hover became a drag.
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") end(); };
  const offList = (on: boolean) => {
    const f = on ? window.addEventListener.bind(window) : window.removeEventListener.bind(window);
    f("pointerup", end, true);
    f("pointercancel", end, true);
    f("blur", end);
    f("keydown", onKey as EventListener, true);
  };

  list.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const name = (e.target as HTMLElement).closest<HTMLElement>(opts.handle ?? ".rack-name");
    const r = opts.handle ? name : name?.parentElement;
    if (!name || !r || r.parentElement !== list || !r.dataset.key || (name as HTMLButtonElement).disabled) return;
    row = r;
    startY = horiz ? e.clientX : e.clientY;
    dragging = false;
    offList(true);
  });

  list.addEventListener("pointermove", (e) => {
    if (!row) return;
    if ((e.buttons & 1) === 0) { end(); return; } // primary released where no listener saw it
    if (!dragging) {
      if (Math.abs((horiz ? e.clientX : e.clientY) - startY) < DRAG_PX) return;
      dragging = true;
      if (!opts.handle) repeatPress(row.querySelector<HTMLElement>(".rack-name")!); // undo the press's toggle
      opts.onStart?.();
      row.classList.add("dragging");
      try { list.setPointerCapture(e.pointerId); } catch { /* no capture: the window listeners still end it */ }
    }
    for (const other of keyedRows(list)) {
      if (other === row) continue;
      const box = other.getBoundingClientRect();
      const p = horiz ? e.clientX : e.clientY;
      const lo = horiz ? box.left : box.top;
      const hi = horiz ? box.right : box.bottom;
      if (p < lo || p > hi) continue;
      const before = p < lo + (horiz ? box.width : box.height) / 2;
      list.insertBefore(row, before ? other : other.nextSibling);
      break;
    }
  });

  function end(): void {
    offList(false);
    if (row && dragging) {
      row.classList.remove("dragging");
      saveOrder(list, storeKey, opts.visible);
      suppressClickUntil = performance.now() + 300;
    }
    row = null;
    dragging = false;
  }
  list.addEventListener("pointerup", end);
  list.addEventListener("pointercancel", end);
  list.addEventListener("lostpointercapture", end);
  // the release that ends a drag must not also toggle the row it lands on
  list.addEventListener("click", (e) => {
    if (performance.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); }
  }, { capture: true });
}
