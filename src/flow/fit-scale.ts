// Pure zoom pick for fit-to-view, kept apart from viewport.ts (DOM, toast) so node --test can load it.

/** Largest stop that is at most `ratio` (so a fit never crops), never above `cap`; the smallest
 *  stop when even that does not fit. Reset Layout passes cap 1: 100% unless the graph needs less. */
export function fitScale(ratio: number, stops: readonly number[], cap = Infinity): number {
  const limit = Math.min(ratio, cap);
  return [...stops].reverse().find((s) => s <= limit + 1e-6) ?? stops[0];
}
