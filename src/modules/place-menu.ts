// Pure placement for menus and popovers. placeMenu: the pointer is the top-left corner, clamped so the
// whole menu stays in the window. placeAbove / placeBeside return a Placer that popover.ts calls with
// the attached element's size and the viewport, so the maths stays testable without a DOM.
export const MENU_EDGE = 8;

/** the rect fields placement reads (a DOMRect fits) */
export interface PlaceRect { left: number; right: number; top: number; bottom: number }
/** menu size and viewport in, clamped top-left corner out */
export type Placer = (w: number, h: number, vw: number, vh: number) => { left: number; top: number };

const clampX = (x: number, w: number, vw: number) => Math.max(MENU_EDGE, Math.min(x, vw - w - MENU_EDGE));
const clampY = (y: number, h: number, vh: number) => Math.max(MENU_EDGE, Math.min(y, vh - h - MENU_EDGE));

export function placeMenu(
  x: number, y: number, w: number, h: number, vw: number, vh: number,
): { left: number; top: number } {
  return { left: clampX(x, w, vw), top: clampY(y, h, vh) };
}

// Horizontal centre on an anchor's centre `cx`, clamped to the window's left and right edges.
export function centerOn(cx: number, w: number, vw: number): number {
  return Math.max(MENU_EDGE, Math.min(cx - w / 2, vw - w - MENU_EDGE));
}

/** 4 px above `bar`'s top edge (the gap is the bar's, not the control's), left edge on `rect`'s left
 *  ("start") or right edge on `rect`'s right ("end"); x clamped both ways, top floored at the edge. */
export function placeAbove(rect: PlaceRect, bar: PlaceRect, align: "start" | "end"): Placer {
  return (w, h, vw) => ({
    left: clampX(align === "start" ? rect.left : rect.right - w, w, vw),
    top: Math.max(MENU_EDGE, bar.top - h - 4),
  });
}

/** 6 px right of `rect` or of `edge` (a bar's right edge), whichever is further right; top on `rect`'s
 *  top, clamped to the window. */
export function placeBeside(rect: PlaceRect, edge: number): Placer {
  return (w, h, vw, vh) => ({
    left: clampX(Math.max(rect.right, edge) + 6, w, vw),
    top: clampY(rect.top, h, vh),
  });
}
