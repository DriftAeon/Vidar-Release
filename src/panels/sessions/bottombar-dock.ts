// Where the right mini bar (#bottombar) sits (2026-10-10): the bottom of #workbench while it is
// open, else the bottom of the right pane of a two-pane split, else its own grid row under #main
// (#app, layout.css). The node moves, never a clone, so every listener on its controls survives.
// sessions.ts layout() calls dockBottombar() before it fits the visible panes; the paths that empty
// or remove a pane call rescueBottombar() first so the bar never goes with it.

let bar: HTMLElement | null = null;
let home: HTMLElement | null = null;

function nodes(): { bar: HTMLElement; home: HTMLElement } | null {
  bar ??= document.getElementById("bottombar");
  home ??= document.getElementById("app");
  return bar && home ? { bar, home } : null;
}

/** Moves the bar into #workbench while it is open, else into `rightPane` (the right pane of a split),
 *  else back to #app. The host gets `.bar-host`, which gives up the bar's height (bottombar.css), so
 *  the caller's fit sees the space above the bar. */
export function dockBottombar(workbenchOpen: boolean, rightPane: HTMLElement | undefined): void {
  const n = nodes();
  if (!n) return;
  const host = (workbenchOpen ? document.getElementById("workbench") : rightPane) ?? null;
  for (const prev of document.querySelectorAll(".bar-host")) if (prev !== host) prev.classList.remove("bar-host");
  const dest = host ?? n.home;
  if (host) host.classList.add("bar-host");
  if (n.bar.parentElement !== dest) dest.appendChild(n.bar);
}

/** Before `from` is emptied or removed: takes the bar back to #app if it is docked inside. */
export function rescueBottombar(from: HTMLElement): void {
  const n = nodes();
  if (!n || !from.contains(n.bar)) return;
  from.classList.remove("bar-host");
  n.home.appendChild(n.bar);
}

/** True for an event target inside the bar, wherever it is docked. */
export function inBottombar(t: EventTarget | null): boolean {
  const n = nodes();
  return !!n && t instanceof Node && n.bar.contains(t);
}
