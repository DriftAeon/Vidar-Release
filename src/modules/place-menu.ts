// Pure placement for the module context menu: the pointer is the top-left corner, clamped so the whole menu stays in the window.
export const MENU_EDGE = 8;

export function placeMenu(
  x: number, y: number, w: number, h: number, vw: number, vh: number,
): { left: number; top: number } {
  return {
    left: Math.max(MENU_EDGE, Math.min(x, vw - w - MENU_EDGE)),
    top: Math.max(MENU_EDGE, Math.min(y, vh - h - MENU_EDGE)),
  };
}

// Horizontal centre on an anchor's centre `cx`, clamped to the window's left and right edges.
export function centerOn(cx: number, w: number, vw: number): number {
  return Math.max(MENU_EDGE, Math.min(cx - w / 2, vw - w - MENU_EDGE));
}
