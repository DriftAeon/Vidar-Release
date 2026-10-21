// In-memory filtering for the shared browser: OR within a facet, AND across facets, title search, age
// buckets, and the sanitiser for the persisted selection (`browser.filters`). Pure, no DOM; a leaf module
// so it takes only type imports. prefs-core stores `browser.filters` unsanitised: the shell calls
// `cleanFilters` on read and `writeSource` then `cleanFilters` before every set.
import type { Facet, Item } from "./types";

/** Facet id -> selected values. */
export type Selection = Record<string, string[]>;
/** Source -> its selection; the persisted shape. */
export type Filters = Record<string, Selection>;

export const AGE_BUCKETS = [
  { id: "1d", label: "Past Day" },
  { id: "7d", label: "Past Week" },
  { id: "30d", label: "Past Month" },
  { id: "older", label: "Older" },
  { id: "none", label: "None" },
] as const;

/** Bucket id for an ISO timestamp (`when.ts` offsets are parsed by the caller's `parse`). */
export function ageBucket(ms: number | null, now: number): string {
  if (ms === null) return "none";
  const diff = now - ms;
  if (diff < 86400000) return "1d";
  if (diff < 7 * 86400000) return "7d";
  if (diff < 30 * 86400000) return "30d";
  return "older";
}

export interface FilterEnv { now: number; parse: (iso: string) => number | null }

function valuesOf(item: Item, facet: Facet, env: FilterEnv): string[] {
  const raw = item.facets[facet.id] ?? [];
  if (facet.kind === "age") return raw.length ? [ageBucket(env.parse(raw[0]), env.now)] : ["none"];
  return raw;
}

/** Case-insensitive substring on title and key. */
export function matchesSearch(item: Item, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || item.title.toLowerCase().includes(q) || item.key.toLowerCase().includes(q);
}

function matchesFacet(item: Item, facet: Facet, chosen: string[] | undefined, env: FilterEnv): boolean {
  if (!chosen || chosen.length === 0) return true;
  const have = valuesOf(item, facet, env);
  return chosen.some((v) => have.includes(v));
}

/** Items passing the search and every facet except `skip`. */
function pass(items: Item[], facets: Facet[], sel: Selection, query: string, env: FilterEnv, skip?: string): Item[] {
  return items.filter((it) =>
    matchesSearch(it, query) && facets.every((f) => f.id === skip || matchesFacet(it, f, sel[f.id], env)));
}

export function filterItems(items: Item[], facets: Facet[], sel: Selection, query: string, env: FilterEnv): Item[] {
  return pass(items, facets, sel, query, env);
}

/** Per facet, value -> count over the items passing search and the OTHER facets (not the facet itself).
 *  A selected value missing from the set stays listed with count 0. */
export function facetCounts(
  items: Item[], facets: Facet[], sel: Selection, query: string, env: FilterEnv,
): Record<string, Map<string, number>> {
  const out: Record<string, Map<string, number>> = {};
  for (const f of facets) {
    const counts = new Map<string, number>();
    for (const it of pass(items, facets, sel, query, env, f.id)) {
      for (const v of new Set(valuesOf(it, f, env))) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    for (const v of sel[f.id] ?? []) if (!counts.has(v)) counts.set(v, 0);
    out[f.id] = counts;
  }
  return out;
}

// ---- persisted selection ------------------------------------------------------------------------------

export const MAX_SOURCES = 50;
export const MAX_FACETS = 12;
export const MAX_VALUES = 32;
export const MAX_CHARS = 80;
export const MAX_FILTER_BYTES = 64 * 1024;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const okKey = (k: string) => k.length > 0 && k.length <= MAX_CHARS;

function cleanFacet(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_VALUES) return null;
  if (!v.every((x) => typeof x === "string" && x.length <= MAX_CHARS)) return null;
  const uniq = [...new Set(v as string[])];
  return uniq.length ? uniq : null;
}

function cleanSelection(v: unknown): Selection | null {
  if (!isRec(v)) return null;
  const entries: [string, string[]][] = [];
  for (const [id, raw] of Object.entries(v)) {
    if (entries.length >= MAX_FACETS) break;
    const vals = okKey(id) ? cleanFacet(raw) : null;
    if (vals) entries.push([id, vals]);
  }
  return entries.length ? Object.fromEntries(entries) : null;
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** Sanitise on read and on write. One bad facet drops alone; a bad source drops alone. Over 50 sources, or over
 *  64 KB serialised, the oldest-written source keys (earliest in insertion order) drop first. Non-objects read {}. */
export function cleanFilters(raw: unknown): Filters {
  if (!isRec(raw)) return {};
  let entries: [string, Selection][] = [];
  for (const [src, v] of Object.entries(raw)) {
    const sel = okKey(src) ? cleanSelection(v) : null;
    if (sel) entries.push([src, sel]);
  }
  if (entries.length > MAX_SOURCES) entries = entries.slice(entries.length - MAX_SOURCES);
  while (entries.length > 0 && bytes(Object.fromEntries(entries)) > MAX_FILTER_BYTES) entries.shift();
  return Object.fromEntries(entries);
}

/** The map with `source` set to `sel` and moved to the newest position (an empty `sel` removes it). */
export function writeSource(filters: Filters, source: string, sel: Selection): Filters {
  const rest = Object.entries(filters).filter(([k]) => k !== source);
  const next = Object.keys(sel).length ? [...rest, [source, sel] as [string, Selection]] : rest;
  return cleanFilters(Object.fromEntries(next));
}
