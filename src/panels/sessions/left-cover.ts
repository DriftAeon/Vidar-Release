// A cover for the left session slot: an element that sits where visible[0] sits while the focused
// tab stays focused underneath (unlike Relay's pane, which empties `visible`). Leaf module: both
// sessions.ts (layout) and runes.ts (Modify) import it, neither imports the other.
let cover: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** Sets the cover, or clears it with null. Notifies only on a real change. */
export function setLeftCover(el: HTMLElement | null): void {
  if (el === cover) return;
  cover = el;
  for (const cb of [...listeners]) cb();
}

export function getLeftCover(): HTMLElement | null {
  return cover;
}

/** Subscribes to cover changes; returns the unsubscribe. */
export function onLeftCoverChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** What layout() does with the slot: the session id whose container is hidden (undefined when no
 *  cover applies) and the cover to show. A cover applies only while the workbench is open and a
 *  session holds the left slot; focus and `visible` are never part of the answer. */
export function leftSlot(visible: readonly string[], workbenchOpen: boolean): { hidden?: string; cover: HTMLElement | null } {
  if (!cover || !workbenchOpen || !visible.length) return { cover: null };
  return { hidden: visible[0], cover };
}
