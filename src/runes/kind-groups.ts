// Kind heads for the Runes read view: a runeset card's runes grouped under nested set heads, one per kind, the
// same `details.runes-set hue-<kind>` + `setHead` shape the Generate Runes file lists use (bare/view-files.ts, which
// takes its names and hues from here). Pure grouping plus the one DOM shell; each caller keeps its own open-state tracking.
import { setHead } from "./set-card";
import { KIND_ICON, KIND_NAME, KINDS } from "./kind-icons";
import { titleWords } from "../format";

// PINNED kinds sit above every other head: the user's pick on 2026-10-30 (Rules first, against their own earlier
// advice), kept as an override list so Facts can join later without reordering the rest.
const PINNED = ["rule"];
// Modify's order (skills, agents, hooks), then the other kinds as KINDS lists them
const FIRST = ["skill", "agent", "hook"];
const ORDER = [...PINNED, ...FIRST.filter((k) => !PINNED.includes(k)), ...Object.keys(KINDS).filter((k) => !PINNED.includes(k) && !FIRST.includes(k))];
// kinds with a colour token (runes.css `.runes-set.hue-<kind>`); the rest stay grey
const HUED = new Set(["skill", "agent", "hook", "mcp", "rule", "plugin", "permission", "setting", "fact"]);

/** A kind group's head: the kind's plural (kind-icons.ts), as Modify's heads read (Skills, MCPs). */
export const kindHeadName = (kind: string): string =>
  KINDS[kind]?.plural ?? `${KIND_NAME[kind] ?? titleWords(kind)}s`.replace(/([^aeiou])ys$/i, "$1ies");
export const kindHue = (kind: string): string => (HUED.has(kind) ? `hue-${kind}` : "hue-none");

/** Within a kind group: loaded (on) before off, then by display name, case-insensitive; stable for ties. */
export function sortRunes<T>(items: readonly T[], off: (t: T) => boolean, name: (t: T) => string): T[] {
  return [...items].sort((a, b) => Number(off(a)) - Number(off(b)) || name(a).localeCompare(name(b), undefined, { sensitivity: "base" }));
}

/** `items` split by kind, in Modify's order, then the other kinds, then any unknown kind in first-seen order.
 *  With `order`, each group's items are sorted by `sortRunes` (the kind groups themselves keep their order). */
export function byKind<T>(items: readonly T[], kindOf: (t: T) => string, order?: { off: (t: T) => boolean; name: (t: T) => string }): { kind: string; name: string; items: T[] }[] {
  const seen = new Map<string, T[]>();
  for (const it of items) seen.set(kindOf(it), [...(seen.get(kindOf(it)) ?? []), it]);
  const kinds = [...ORDER.filter((k) => seen.has(k)), ...[...seen.keys()].filter((k) => !ORDER.includes(k))];
  return kinds.map((kind) => ({ kind, name: kindHeadName(kind), items: order ? sortRunes(seen.get(kind)!, order.off, order.name) : seen.get(kind)! }));
}

/** One nested kind head over `tray`; `track` sets its open state (default open) and records its toggles. */
export function kindGroup(kind: string, count: number | string, tray: HTMLElement, track: (det: HTMLDetailsElement) => void): HTMLDetailsElement {
  const det = document.createElement("details");
  det.className = `runes-set ${kindHue(kind)}`;
  det.dataset.kindHead = kind;
  det.append(setHead(kindHeadName(kind), count, KIND_ICON[kind] ?? null), tray);
  track(det);
  return det;
}
