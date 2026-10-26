// Notion IPC replies as browser Items, and every Notion error as a title and a message (docs/projects/notion/plan.md
// § Views). Top-level hits band as "Databases" then "Pages"; data-source rows take their facets and group from
// facets.ts. Pure apart from relative/absolute time formatting; no DOM, no IPC.
import { absoluteTime, relativeTime } from "../browser/when";
import type { Field, Item, Lead } from "../browser/types";
import type { LucideName } from "../icons";
import { colorClass } from "./rich-text";
import type { NotionErrorKind, NotionHit, NotionPage, NotionRow } from "./ipc";
import { EDITED, NONE, groupOf, type Plan } from "./facets";

export type NotionErr = { kind: NotionErrorKind; message: string; retryAfter?: number };
export interface Copy { title: string; message: string }

export const SEND_TIP = "Types the title and link into the focused tab without sending it.";
export const DATABASE_TIP = "Opens the database.";

const BANDS = {
  source: { id: "databases", label: "Databases", tone: "neutral", rank: 0 },
  page: { id: "pages", label: "Pages", tone: "neutral", rank: 1 },
} as const;

const titleOf = (t: string) => t.trim() || "Untitled";
/** The Edited field the model adds to every item: not a page property, so it hides none in pageFields. */
const SYNTHETIC = new WeakSet<Field>();
const edited = (iso: string): Field => {
  const f: Field = { label: "Edited", value: relativeTime(iso) };
  SYNTHETIC.add(f);
  return f;
};

/** Notion's built-in icon names -> Lucide glyphs; a name not listed falls back to the file glyph, still tinted. */
const NATIVE: Record<string, LucideName> = {
  checklist: "list-checks", checkmark: "check", document: "file-text", folder: "folder", bookmark: "bookmark",
  bug: "bug", lock: "lock", bolt: "zap", lightning: "zap", person: "user", people: "users", hashtag: "hash",
  code: "file-code",
};

/** The lead for a built-in icon: the mapped glyph (else `fallback`) tinted by the icon's colour. */
function nativeLead(name: string, color: string, fallback: LucideName): Lead {
  const cls = colorClass(color);
  return { glyph: Object.hasOwn(NATIVE, name) ? NATIVE[name] : fallback, ...(cls ? { cls } : {}) };
}

/** A database hit always shows the book-database icon, even when Notion gave it an emoji or built-in icon. */
export function hitItem(h: NotionHit): Item {
  const lead: Lead = h.kind === "source" ? { color: "notion-database" }
    : h.icon ? { emoji: h.icon }
    : h.iconName ? nativeLead(h.iconName, h.iconColor, "file-text")
    : { color: "notion-page" };
  return {
    id: h.id, key: "", title: titleOf(h.title), status: "", updated: h.lastEdited,
    group: { ...BANDS[h.kind === "source" ? "source" : "page"] },
    lead,
    ...(h.kind === "source" ? { tip: DATABASE_TIP } : {}),
    facets: { [EDITED]: h.lastEdited ? [h.lastEdited] : [] },
    fields: [edited(h.lastEdited)],
  };
}

/** Up to two tag pills from the plan's tag property (None never shows). */
function tagsOf(row: NotionRow, plan: Plan): Item["tags"] {
  const rule = plan.tags;
  if (!rule) return undefined;
  const out = (row.values[rule.prop.id] ?? [])
    .filter((v) => v !== NONE && v !== "")
    .slice(0, 2)
    .map((label) => ({ label, tone: rule.tones.get(label) ?? ("neutral" as const) }));
  return out.length ? out : undefined;
}

/** A data-source row: one value list per chip property ("" = None), its D4 group, then the card fields.
 *  `anyIcon`: some row of the source has an emoji or built-in icon, so the others keep a blank slot and titles align;
 *  with none, no row has a lead. */
export function rowItem(row: NotionRow, plan: Plan, anyIcon = false): Item {
  const facets: Record<string, string[]> = { [EDITED]: row.lastEdited ? [row.lastEdited] : [] };
  for (const p of plan.chips) {
    const v = row.values[p.id] ?? [];
    facets[p.id] = v.length ? [...v] : [NONE];
  }
  const { group, status } = groupOf(plan, row.values);
  const fields: Field[] = plan.fields.map((p) => ({ label: p.name, value: (row.values[p.id] ?? []).join(", ") }));
  fields.push(edited(row.lastEdited));
  const lead: Lead | undefined = row.icon ? { emoji: row.icon }
    : row.iconName ? nativeLead(row.iconName, row.iconColor, "file-text")
    : anyIcon ? { blank: true } : undefined;
  const tags = tagsOf(row, plan);
  return {
    id: row.id, key: "", title: titleOf(row.title), status, updated: row.lastEdited, group, facets, fields,
    ...(lead ? { lead } : {}), ...(tags ? { tags } : {}),
  };
}

/** Fullscreen's extra fields: the page's properties in schema order, less those the row already shows, then
 *  "Created". Each row property field hides at most one property with its label, so a property that only
 *  shares a label with another is kept; the model's own Edited hides none. Created (the page's creation
 *  time, not a property) is added when no field is labelled Created already. */
export function pageFields(page: NotionPage, item: Item): Field[] {
  const shown = new Map<string, number>();
  for (const f of item.fields) if (!SYNTHETIC.has(f)) shown.set(f.label, (shown.get(f.label) ?? 0) + 1);
  const out: Field[] = [];
  for (const f of page.fields) {
    const n = shown.get(f.label) ?? 0;
    if (n > 0) { shown.set(f.label, n - 1); continue; }
    out.push({ ...f });
  }
  const created = absoluteTime(page.created);
  const named = (f: Field) => f.label === "Created";
  if (created && !item.fields.some(named) && !out.some(named)) out.push({ label: "Created", value: created });
  return out;
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** First-level child_page blocks of the first children page, as page Items (the Subpages section). */
export function subpageItems(blocks: unknown[]): Item[] {
  const out: Item[] = [];
  for (const b of blocks) {
    const r = rec(b);
    if (!r || r.type !== "child_page" || typeof r.id !== "string" || !UUID.test(r.id)) continue;
    const title = typeof rec(r.child_page)?.title === "string" ? (rec(r.child_page)!.title as string) : "";
    const when = typeof r.last_edited_time === "string" ? r.last_edited_time : "";
    out.push({
      id: r.id.toLowerCase(), key: "", title: titleOf(title), status: "", updated: when,
      facets: { [EDITED]: when ? [when] : [] }, fields: [edited(when)],
    });
  }
  return out;
}

/** The fallback page link for an id with no url seen yet (plan § IPC: www.notion.so/<32hex>). */
export const fallbackUrl = (id: string) => `https://www.notion.so/${id.replace(/-/g, "").toLowerCase()}`;

/** Kinds whose message is a full sentence shown under the title; the rest carry a Rust text as a tooltip. */
export const SHOWN_KINDS: ReadonlySet<NotionErrorKind> = new Set(["forbidden", "missing", "rate"]);

export function errorCopy(e: NotionErr): Copy {
  switch (e.kind) {
    case "forbidden":
      return { title: "Notion Needs Read Content", message: "Turn on Read Content for the connection in Notion." }; // note-ok: docs/projects/notion/plan.md
    case "missing":
      return { title: "Page Not Shared", message: "Share the page with the connection in Notion." }; // note-ok: docs/projects/notion/plan.md
    case "rate": {
      const n = Math.max(1, Math.ceil(typeof e.retryAfter === "number" && Number.isFinite(e.retryAfter) ? e.retryAfter : 1));
      return { title: "Notion Is Busy", message: `Try again in ${n} s.` }; // note-ok: docs/projects/notion/plan.md
    }
    case "network":
      return { title: "Notion Did Not Answer", message: e.message };
    case "auth":
      return { title: "Notion Refused the Token", message: e.message };
    case "unset":
      return { title: "Notion Not Connected", message: e.message };
    default:
      return { title: "Notion Couldn't Load This", message: e.message };
  }
}

/** The connect form's line: auth and network have their own titles, anything else is "Couldn't Connect". */
export function connectCopy(e: NotionErr): Copy {
  if (e.kind === "auth") return { title: "Notion Refused the Token", message: e.message };
  if (e.kind === "network") return { title: "Notion Did Not Answer", message: e.message };
  return { title: "Notion Couldn't Connect", message: e.message };
}

export const TOP_CAP_NOTE = "Showing the most recent pages. Search in Notion to find older ones."; // note-ok: docs/projects/notion/plan.md
export const ROW_CAP_NOTE = "Showing the first 2000 rows. Filter the database in Notion to see the rest."; // note-ok: docs/projects/notion/plan.md

export function partialNote(n: number): string {
  return `Only ${n} ${n === 1 ? "row" : "rows"} loaded. Refresh to try again.`; // note-ok: docs/projects/notion/plan.md
}
