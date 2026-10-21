// Bands for the list: rank, then label. Items with no group share one band labelled "", placed last.
import type { GroupFacet, Item, Tone } from "./types";

export interface Band { id: string; label: string; tone: Tone; rank: number; items: Item[]; facet?: GroupFacet }

const UNGROUPED = "\u0000ungrouped";

export function groupItems(items: Item[]): Band[] {
  const bands = new Map<string, Band>();
  for (const item of items) {
    const g = item.group;
    const id = g ? g.id : UNGROUPED;
    let band = bands.get(id);
    if (!band) {
      band = g
        ? { id: g.id, label: g.label, tone: g.tone, rank: g.rank, items: [], ...(g.facet ? { facet: g.facet } : {}) }
        : { id: "", label: "", tone: "neutral", rank: Number.POSITIVE_INFINITY, items: [] };
      bands.set(id, band);
    }
    band.items.push(item);
  }
  return [...bands.values()].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

export interface Segment { label: string; tone: Tone; n: number; facet: GroupFacet }

/** The status strip's segments: one per band of `source` (the unfiltered rows), in band order, with `n`
 *  counted in `shown` (0 when a filter empties the band). [] unless every band carries a facet and there
 *  are at least two, so top-level lists and Jira never show a strip. */
export function segments(source: Item[], shown: Item[] = source): Segment[] {
  const bands = groupItems(source);
  if (bands.length < 2 || bands.some((b) => !b.facet)) return [];
  const counts = new Map<string, number>();
  for (const b of groupItems(shown)) counts.set(b.id, b.items.length);
  return bands.map((b) => ({ label: b.label, tone: b.tone, n: counts.get(b.id) ?? 0, facet: b.facet! }));
}
