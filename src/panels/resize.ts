// Right-panel resize grip.
//
// Writes --rightbar-w on #app; the grid column and #status-expanded both read
// it, so there's no second place to keep in sync. Terminals need no special
// handling — changing the column resizes .term-container, which its existing
// ResizeObserver already turns into fit() + resize_pty.

import { getPref, setPref } from "../prefs";

const DEFAULT_W = 183; // 40px under the 223 in use (Tools moved to the left bar)
const MIN_W = 160;
const MAX_W = 520;

let app: HTMLElement;

// never let the panel eat more than half the window, however wide it was saved
function clamp(w: number): number {
  return Math.round(Math.max(MIN_W, Math.min(w, MAX_W, window.innerWidth * 0.5)));
}

function apply(w: number, persist: boolean) {
  app.style.setProperty("--rightbar-w", `${w}px`);
  if (persist) setPref("rightbar.width", w);
}

export function initRightbarResize(grip: HTMLElement, signal?: AbortSignal) {
  app = document.getElementById("app")!;
  const saved = getPref("rightbar.width") ?? 0;
  apply(clamp(saved > 0 ? saved : DEFAULT_W), false);

  // Width follows the pointer's movement from where the press started, not its
  // absolute x: the grip is 7px wide, so snapping the border to the cursor made
  // every plain click nudge the panel and walk the grip out from under a dblclick.
  let startX = 0, startW = 0;
  const widthAt = (x: number) => clamp(startW + startX - x);

  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    // capture so the drag survives the pointer crossing the terminal or
    // leaving the window entirely
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("rightbar-resizing");
    startX = e.clientX;
    startW = parseInt(getComputedStyle(app).getPropertyValue("--rightbar-w"), 10) || DEFAULT_W;
  }, { signal });

  grip.addEventListener("pointermove", (e) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    apply(widthAt(e.clientX), false);
  }, { signal });

  const end = (e: PointerEvent) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    grip.releasePointerCapture(e.pointerId);
    document.body.classList.remove("rightbar-resizing");
    // a press without movement is a click, not a resize; persist only real drags
    if (e.clientX !== startX) apply(widthAt(e.clientX), true);
  };
  grip.addEventListener("pointerup", end, { signal });
  grip.addEventListener("pointercancel", end, { signal });

  grip.addEventListener("dblclick", () => apply(DEFAULT_W, true), { signal });

  // a narrowed window can invalidate a saved width; re-clamp rather than let
  // the panel crowd out the terminal
  window.addEventListener("resize", () => {
    const cur = parseInt(getComputedStyle(app).getPropertyValue("--rightbar-w"), 10);
    if (Number.isFinite(cur)) apply(clamp(cur), false);
  }, { signal });
}
