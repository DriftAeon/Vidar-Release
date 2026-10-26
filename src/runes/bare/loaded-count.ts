// Pure helpers for the Bare Runes view: what a launch loads (activate always) against what it only
// offers (recall, paths), the `<loaded>/<total>` strings, and the Always, Paths, Recall order in a category.
import { runeName } from "../cards";
import type { RuneItem } from "../types";

interface Loadable { activate?: string }
interface Named extends Loadable { id: string; path: string; section: readonly string[] }

/** A rune loads at spawn unless it is recall or paths; no activate counts as always. */
export const isLoaded = (b: Loadable): boolean => b.activate !== "recall" && b.activate !== "paths";

/** `<loaded>/<total>` over `items`, plus `extra` runes that are never loaded (the On Demand list). */
export function loadedOfTotal(items: readonly Loadable[], extra = 0): string {
  return `${items.filter(isLoaded).length}/${items.length + extra}`;
}

/** The cost-bar label: `8,691/13,458 Tokens`, no tilde (the numbers are estimates, the tooltip says so). */
export function tokenLabel(loaded: number, total: number): string {
  const f = (n: number): string => n.toLocaleString("en-US");
  return `${f(loaded)}/${f(total)} Tokens`;
}

const rank = (b: Loadable): number => (b.activate === "recall" ? 2 : b.activate === "paths" ? 1 : 0);
const label = (b: Named): string => runeName({ id: b.id, path: b.path } as RuneItem);

/** Within each category (a run opened by a new depth-0 label), Always first, then Paths, then Recall, alphabetical by
 *  the shown name. Sub-label groups keep their order; the order of categories is untouched. */
export function orderByLoad<T extends Named>(bricks: readonly T[], opensCategory: (index: number) => boolean): T[] {
  const out: T[] = [];
  for (let start = 0; start < bricks.length;) {
    let end = start + 1;
    while (end < bricks.length && !opensCategory(end)) end++;
    const groups = new Map<string, T[]>();
    for (const b of bricks.slice(start, end)) {
      const key = b.section.join("\u0000");
      groups.set(key, [...(groups.get(key) ?? []), b]);
    }
    for (const g of groups.values()) {
      out.push(...g.map((b, i) => ({ b, i })).sort((x, y) => rank(x.b) - rank(y.b) || label(x.b).localeCompare(label(y.b), "en") || x.i - y.i).map((e) => e.b));
    }
    start = end;
  }
  return out;
}
