// Pure order merge shared by drag, keyboard and Settings moves.

/** Merge a new visible order into the saved one. Saved ids absent from `visible` (dormant: hidden
 *  surface, unavailable server) keep their slot right after the saved entry that preceded them
 *  (none: at the front), so their order among themselves and against visible neighbours survives.
 *  Duplicates keep their first occurrence; visible ids missing from `saved` stay where `visible` puts them. */
export function mergeVisibleOrder(saved: readonly string[], visible: readonly string[]): string[] {
  const next = [...new Set(visible)];
  const shown = new Set(next);
  const old = [...new Set(saved)];
  for (const [i, id] of old.entries()) {
    if (shown.has(id)) continue;
    const prev = i > 0 ? old[i - 1] : undefined; // visible or an earlier dormant, already placed
    next.splice(prev === undefined ? 0 : next.indexOf(prev) + 1, 0, id);
  }
  return next;
}
