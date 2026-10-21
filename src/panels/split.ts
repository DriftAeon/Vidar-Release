// Pane divider for dual-view — terminal/terminal and terminal/workbench alike.
//
// A real flex item sitting between the panes (order 1; the left pane is order
// 0, the right pane or workbench order 2), not a pseudo-element, so it can take
// the pointer. Writes --split (px) on #view-sessions: the left pane's
// flex-basis reads it, the right pane fills what's left. Terminals need no
// special handling — the width change reaches their ResizeObserver, and
// syncPty only tells the pty when the column count actually moved.
//
// Same shape as panels/resize.ts (the right-bar grip): capture the pointer,
// apply live, persist once on release, double-click resets.

import { getPref, setPref } from "../prefs";

const MIN = 240; // px, each side — below this a TUI is unreadable anyway
const GRIP_W = 4;

let view: HTMLElement;
let grip: HTMLElement;

function contentBox() {
  const cs = getComputedStyle(view);
  const left = view.getBoundingClientRect().left + parseFloat(cs.paddingLeft);
  const width = view.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return { left, width };
}

function clamp(px: number): number {
  const { width } = contentBox();
  // hidden or absurdly narrow view: nothing sensible to clamp against
  if (width < MIN * 2 + GRIP_W) return Math.round(px);
  return Math.round(Math.max(MIN, Math.min(px, width - GRIP_W - MIN)));
}

function apply(px: number | null, persist: boolean) {
  if (px === null) {
    view.style.removeProperty("--split");
    if (persist) setPref("split.width", undefined);
    return;
  }
  view.style.setProperty("--split", `${px}px`);
  if (persist) setPref("split.width", px);
}

function fromPointer(e: PointerEvent): number {
  return clamp(e.clientX - contentBox().left - GRIP_W / 2);
}

export function initSplit(sessionsView: HTMLElement) {
  view = sessionsView;
  grip = document.createElement("div");
  grip.id = "split-grip";
  grip.title = "Resize (double-click to centre)";
  view.appendChild(grip);

  const saved = getPref("split.width") ?? 0;
  if (saved > 0) apply(clamp(saved), false);

  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("split-resizing");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    apply(fromPointer(e), false);
  });
  const end = (e: PointerEvent) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    grip.releasePointerCapture(e.pointerId);
    document.body.classList.remove("split-resizing");
    apply(fromPointer(e), true);
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("dblclick", () => apply(null, true));

  // a narrowed window can invalidate a saved split; re-clamp rather than let
  // one pane vanish
  window.addEventListener("resize", () => {
    const cur = parseFloat(view.style.getPropertyValue("--split"));
    if (Number.isFinite(cur)) apply(clamp(cur), false);
  });
}
