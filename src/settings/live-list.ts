// Settings lists that redraw from a fresh read (Agents, Macros, Workspaces): a redraw replaces every
// element, so it carries the focused control, its caret and any typed-but-uncommitted text across.

export type Live = Set<{ root: HTMLElement; render: () => void }>;

const CONTROLS = "input, select, textarea, button";

let redrawing = false;
const pendingFocus = new WeakMap<HTMLElement, string>();

/** True while a redraw rebuilds: field events fired by the rebuild are not edits. */
export function isRedrawing(): boolean {
  return redrawing;
}

/** Redraw every live list; detached ones are dropped on the pass. */
export function refreshLive(live: Live): void {
  for (const r of live) {
    if (!r.root.isConnected) live.delete(r);
    else r.render();
  }
}

/** Focus `selector`'s match in `root` once a draw lands (a draw superseded by a newer read never lands). */
export function focusOnNextDraw(root: HTMLElement, selector: string): void {
  pendingFocus.set(root, selector);
}

/** A list control that redraws from a fresh read on open and whenever `refreshLive` runs. */
export function liveList<S>(live: Live, read: () => Promise<S>, draw: (root: HTMLElement, s: S) => void): HTMLElement {
  const root = document.createElement("div");
  root.className = "ws-list ag-list";
  let gen = 0;
  const render = () => {
    const mine = ++gen;
    void read().then((s) => {
      if (mine !== gen) return; // a newer read superseded this one
      redraw(root, () => draw(root, s));
    });
  };
  live.add({ root, render });
  render();
  return root;
}

const controlsOf = (row: Element): HTMLElement[] =>
  row.matches(CONTROLS) ? [row as HTMLElement] : [...row.querySelectorAll<HTMLElement>(CONTROLS)];

interface Held {
  row: number;
  ctl: number;
  el: HTMLElement;
  start: number | null;
  end: number | null;
  dir: "forward" | "backward" | "none" | null;
}

function capture(root: HTMLElement): Held | null {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || a === root || !root.contains(a)) return null;
  let row: Element = a;
  while (row.parentElement && row.parentElement !== root) row = row.parentElement;
  const text = a as HTMLInputElement;
  const caret = typeof text.selectionStart === "number";
  return {
    row: [...root.children].indexOf(row),
    ctl: controlsOf(row).indexOf(a),
    el: a,
    start: caret ? text.selectionStart : null,
    end: caret ? text.selectionEnd : null,
    dir: caret ? text.selectionDirection : null,
  };
}

function restore(root: HTMLElement, h: Held): void {
  if (root.children.length === 0) return;
  const row = root.children[Math.min(Math.max(h.row, 0), root.children.length - 1)];
  const all = controlsOf(row);
  let next: HTMLElement | undefined = all[h.ctl];
  if (!next || (next as HTMLButtonElement).disabled) next = all.filter((c) => !(c as HTMLButtonElement).disabled).pop();
  if (!next) return;
  const was = h.el as HTMLInputElement;
  const now = next as HTMLInputElement;
  if (typeof was.defaultValue === "string" && typeof now.defaultValue === "string"
    && was.value !== was.defaultValue && now.defaultValue === was.defaultValue) {
    now.value = was.value; // typed, not committed: the field it belonged to
  }
  next.focus({ preventScroll: true });
  if (h.start !== null && h.end !== null && typeof now.selectionStart === "number") {
    try { now.setSelectionRange(h.start, h.end, h.dir ?? undefined); } catch { /* not a text field */ }
  }
}

/** Rebuild `root` through `draw`, keeping the focused control (or the pending `focusOnNextDraw` one). */
export function redraw(root: HTMLElement, draw: () => void): void {
  const held = capture(root);
  redrawing = true;
  try {
    root.replaceChildren();
    draw();
  } finally {
    redrawing = false;
  }
  const sel = pendingFocus.get(root);
  if (sel !== undefined) {
    pendingFocus.delete(root);
    const target = root.querySelector<HTMLElement>(sel);
    if (target) {
      target.focus({ preventScroll: true });
      return;
    }
  }
  if (held) restore(root, held);
}
