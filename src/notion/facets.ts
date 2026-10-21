// Facets and bands for one Notion data source (docs/projects/notion/plan.md D3, D4). Chips come only from
// status, select, multi_select, people and checkbox properties. Top row: the group property, then the other
// status/select properties by name, at most 3; the rest sit behind More by name, then "Edited" (age); at most
// 12 in all. Grouping: the first status by name (bands per option, in groups[] order then option order, toned
// from the group name); else exactly one select (option order, toned from the option colour); else flat. Pure, no DOM.
import type { Facet, Group, Tone } from "../browser/types";
import type { NotionProp, NotionSource } from "./ipc";

/** Facet id of the age facet; "@" is outside the property-id alphabet, so it never meets a real id. */
export const EDITED = "@edited";
/** The chip value of an empty property; labelled "None". */
export const NONE = "";
export const MAX_FACETS = 12;
export const MAX_TOP = 3;

const CHIP_TYPES: ReadonlySet<string> = new Set(["status", "select", "multi_select", "people", "checkbox"]);

export const valueLabel = (v: string): string => (v === NONE ? "None" : v);

export const editedFacet: Facet = { id: EDITED, label: "Edited", place: "more", kind: "age", valueLabel: (v) => v };

/** The top level has only "Edited" (D3). */
export const topFacets = (): Facet[] => [editedFacet];

interface Band { label: string; tone: Tone; rank: number }
/** The tag property shown as pills on rows, with its option colours by name. */
export interface TagRule { prop: NotionProp; tones: Map<string, Tone> }
interface GroupRule { prop: NotionProp; bands: Map<string, Band>; empty: string; status: boolean }

export interface Plan {
  facets: Facet[];
  /** Chip properties kept (top first, then More), in facet order. */
  chips: NotionProp[];
  /** The same properties by name, for the card's field bar. */
  fields: NotionProp[];
  /** filter_properties: the title property, then the chips. */
  props: string[];
  group: GroupRule | null;
  /** The pill property: the first multi-select by name, else the first select that is not the group. */
  tags: TagRule | null;
}

const byName = (a: NotionProp, b: NotionProp) => {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Notion's option colour as a tone: blue todo, yellow/orange progress, purple/pink review, red blocked,
 *  green done; default, gray, brown and anything unknown neutral. */
export function toneForColor(color: string): Tone {
  switch (color) {
    case "blue": return "todo";
    case "yellow": case "orange": return "progress";
    case "purple": case "pink": return "review";
    case "red": return "blocked";
    case "green": return "done";
    default: return "neutral";
  }
}

/** D4 tones: the group name decides (option name when there is no group); inside a progress group an option
 *  reading review or block takes that tone. */
export function toneFor(groupName: string, option: string): Tone {
  const g = groupName || option;
  if (/to.?do|not started/i.test(g)) return "todo";
  if (/progress/i.test(g)) {
    if (/\breview/i.test(option)) return "review";
    if (/\bblock/i.test(option)) return "blocked";
    return "progress";
  }
  if (/complete|done/i.test(g)) return "done";
  return "neutral";
}

function statusRule(prop: NotionProp): GroupRule {
  const at = new Map(prop.options.map((o, i) => [o.name, i] as const));
  const order: { name: string; group: string }[] = [];
  const seen = new Set<string>();
  for (const g of prop.groups) {
    const names = g.options.filter((n) => at.has(n) && !seen.has(n)).sort((a, b) => at.get(a)! - at.get(b)!);
    for (const n of names) { seen.add(n); order.push({ name: n, group: g.name }); }
  }
  for (const o of prop.options) if (!seen.has(o.name)) { seen.add(o.name); order.push({ name: o.name, group: "" }); }
  const bands = new Map(order.map((o, i) => [o.name, { label: o.name, tone: toneFor(o.group, o.name), rank: i }] as const));
  return { prop, bands, empty: "No Status", status: true };
}

function selectRule(prop: NotionProp): GroupRule {
  const bands = new Map<string, Band>();
  for (const o of prop.options) if (!bands.has(o.name)) bands.set(o.name, { label: o.name, tone: toneForColor(o.color), rank: bands.size });
  return { prop, bands, empty: "None", status: false };
}

function chip(p: NotionProp, place: "top" | "more"): Facet {
  return { id: p.id, label: p.name.trim() || "Untitled", place, kind: "multi", valueLabel };
}

export function planFor(source: NotionSource): Plan {
  const chips = source.props.filter((p) => CHIP_TYPES.has(p.type));
  const statuses = chips.filter((p) => p.type === "status").sort(byName);
  const selects = chips.filter((p) => p.type === "select");
  const groupProp = statuses[0] ?? (selects.length === 1 ? selects[0] : null);
  const others = chips.filter((p) => p !== groupProp && (p.type === "status" || p.type === "select")).sort(byName);
  const room = MAX_FACETS - 1; // "Edited" takes the last place
  const top = [...(groupProp ? [groupProp] : []), ...others].slice(0, Math.min(MAX_TOP, room));
  const more = chips.filter((p) => !top.includes(p)).sort(byName).slice(0, room - top.length);
  const kept = [...top, ...more];
  const title = source.props.find((p) => p.type === "title");
  const tagProp = chips.filter((p) => p.type === "multi_select").sort(byName)[0]
    ?? chips.filter((p) => p.type === "select" && p !== groupProp).sort(byName)[0]
    ?? null;
  // Requested even when it missed the kept chips: filter_properties is the only way to get its values.
  const tagId = tagProp && !kept.includes(tagProp) ? [tagProp.id] : [];
  return {
    facets: [...top.map((p) => chip(p, "top")), ...more.map((p) => chip(p, "more")), editedFacet],
    chips: kept,
    fields: [...kept].sort(byName),
    props: [...(title ? [title.id] : []), ...tagId, ...kept.map((p) => p.id)],
    group: groupProp ? (groupProp.type === "status" ? statusRule(groupProp) : selectRule(groupProp)) : null,
    tags: tagProp ? { prop: tagProp, tones: new Map(tagProp.options.map((o) => [o.name, toneForColor(o.color)] as const)) } : null,
  };
}

/** The row's band and pill text: the group value, or "" (pill hidden). No group rule, no band (one flat band). */
export function groupOf(plan: Plan, values: Record<string, string[]>): { group: Group | undefined; status: string } {
  const rule = plan.group;
  if (!rule) return { group: undefined, status: "" };
  const v = values[rule.prop.id]?.[0] ?? NONE;
  if (v === NONE) {
    return {
      group: { id: "\u0000none", label: rule.empty, tone: "neutral", rank: Number.MAX_SAFE_INTEGER, facet: { id: rule.prop.id, value: NONE } },
      status: "",
    };
  }
  const band = rule.bands.get(v)
    ?? { label: v, tone: rule.status ? toneFor("", v) : "neutral", rank: rule.bands.size };
  return {
    group: { id: `v:${v}`, label: band.label, tone: band.tone, rank: band.rank, facet: { id: rule.prop.id, value: v } },
    status: v,
  };
}
