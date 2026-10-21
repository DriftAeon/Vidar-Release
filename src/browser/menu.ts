// Body-fixed menus for the browser's filter chips: one main menu plus one side list (More's facets).
// The elements exist only while open. They close on outside pointerdown, window resize, document hide,
// Escape, Tab, and whenever the shell calls close() (its root resized or hidden: tab switch, module
// hide) or dispose(). Placement follows the filter bar's bottom edge, 4 px below it (ui-look.md).
// Keys: Up/Down move, Enter/Space are the native button click, Right opens a side list, Left closes it.

export interface MenuHost {
  /** Opens the main menu under `bar`, left-aligned with `anchor`; replaces any open menu. */
  open(anchor: HTMLElement, bar: HTMLElement, build: (m: HTMLDivElement) => void, label: string): void;
  /** Opens a side list beside `row` (a row of the main menu). */
  openSide(row: HTMLElement, build: (m: HTMLDivElement) => void, label: string): void;
  /** True when something was open. Focus returns to the anchor only when `refocus`. */
  close(refocus?: boolean): boolean;
  isOpen(): boolean;
  /** Re-runs the open menus' builds in place, keeping the focused row by index. */
  rerender(): void;
  /** A re-render replaced the anchor: the open menu follows the new element. */
  setAnchor(el: HTMLElement): void;
  dispose(): void;
}

interface Open { el: HTMLDivElement; build: (m: HTMLDivElement) => void; owner: HTMLElement }

const GAP = 4;
const EDGE = 8;

const items = (m: HTMLElement) => [...m.querySelectorAll<HTMLButtonElement>("button.br-mi:not(:disabled)")];

function place(m: HTMLElement, left: number, top: number): void {
  const maxLeft = window.innerWidth - m.offsetWidth - EDGE;
  const maxTop = window.innerHeight - m.offsetHeight - EDGE;
  m.style.left = `${Math.max(EDGE, Math.min(left, maxLeft))}px`;
  m.style.top = `${Math.max(EDGE, Math.min(top, maxTop))}px`;
}

function fill(o: Open): void {
  const focused = items(o.el).indexOf(document.activeElement as HTMLButtonElement);
  o.el.replaceChildren();
  o.build(o.el);
  if (focused >= 0) (items(o.el)[focused] ?? items(o.el).at(-1))?.focus();
}

export function menuHost(onClose?: () => void): MenuHost {
  let main: Open | null = null;
  let side: Open | null = null;
  let live = false;
  let disposed = false;

  const make = (label: string, cls: string): HTMLDivElement => {
    const m = document.createElement("div");
    m.className = cls;
    m.setAttribute("role", "menu");
    m.setAttribute("aria-label", label);
    m.addEventListener("keydown", onKey);
    return m;
  };

  function closeSide(refocus: boolean): void {
    if (!side) return;
    const owner = side.owner;
    side.el.remove();
    side = null;
    owner.setAttribute("aria-expanded", "false");
    if (refocus) owner.focus();
  }

  function close(refocus = false): boolean {
    if (!main) return false;
    closeSide(false);
    const owner = main.owner;
    main.el.remove();
    main = null;
    unlisten();
    owner.setAttribute("aria-expanded", "false");
    if (refocus && owner.isConnected) owner.focus();
    onClose?.();
    return true;
  }

  function onKey(e: KeyboardEvent): void {
    const m = e.currentTarget as HTMLDivElement;
    const list = items(m);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const inSide = side?.el === m;
    let handled = true;
    if (e.key === "ArrowDown") list[(at + 1) % list.length]?.focus();
    else if (e.key === "ArrowUp") list[at <= 0 ? list.length - 1 : at - 1]?.focus();
    else if (e.key === "Home") list[0]?.focus();
    else if (e.key === "End") list.at(-1)?.focus();
    else if (e.key === "ArrowRight" && !inSide && list[at]?.dataset.sub) list[at].click();
    else if (e.key === "ArrowLeft" && inSide) closeSide(true);
    else if (e.key === "Escape") {
      if (inSide) closeSide(true);
      else close(true);
    } else if (e.key === "Tab") {
      close(true);
      handled = false;
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  const onDown = (e: Event) => {
    const t = e.target as Node;
    if (main?.el.contains(t) || side?.el.contains(t) || main?.owner.contains(t)) return;
    close();
  };
  const onResize = () => { close(); };
  const onVisibility = () => { if (document.hidden) close(); };

  function listen(): void {
    if (live) return;
    live = true;
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
  }

  function unlisten(): void {
    if (!live) return;
    live = false;
    document.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onVisibility);
  }

  return {
    open(anchor, bar, build, label) {
      if (disposed) return;
      close();
      const el = make(label, "br-menu");
      main = { el, build, owner: anchor };
      build(el);
      document.body.appendChild(el);
      place(el, anchor.getBoundingClientRect().left, bar.getBoundingClientRect().bottom + GAP);
      anchor.setAttribute("aria-expanded", "true");
      listen();
      items(el)[0]?.focus();
    },
    openSide(row, build, label) {
      if (!main || disposed) return;
      closeSide(false);
      const el = make(label, "br-menu br-menu-side");
      side = { el, build, owner: row };
      build(el);
      document.body.appendChild(el);
      const r = row.getBoundingClientRect();
      const right = r.right + GAP;
      const left = right + el.offsetWidth > window.innerWidth - EDGE ? r.left - GAP - el.offsetWidth : right;
      place(el, left, r.top - GAP);
      row.setAttribute("aria-expanded", "true");
      items(el)[0]?.focus();
    },
    close,
    isOpen: () => main !== null,
    rerender() {
      if (main) fill(main);
      if (main && side) {
        const sub = side.owner.dataset.sub;
        const row = items(main.el).find((b) => b.dataset.sub === sub);
        if (row) {
          side.owner = row;
          row.setAttribute("aria-expanded", "true");
        }
        fill(side);
      }
    },
    setAnchor(el) {
      if (!main) return;
      main.owner = el;
      el.setAttribute("aria-expanded", "true");
    },
    dispose() {
      close();
      disposed = true;
    },
  };
}
