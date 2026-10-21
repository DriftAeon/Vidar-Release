// The Notion block renderer (docs/projects/notion/plan.md D7, D8, § Views › Blocks; S6, S12). The DOM trust
// boundary for page bodies: createElement and textContent only, tags from el()'s allowlist, classes from
// BLOCK_CLASSES and the colour list, never href, src, style or on*. render() is synchronous; further
// pages and children fill in through walk.ts, which checks ctx.alive() before every fill.
import { el, inertLink, safeUrl } from "../browser/rich";
import type { RenderCtx, RichRenderer } from "../browser/types";
import { COLOR_CLASSES, appendRich, colorClass, plainText, rec, str } from "./rich-text";
import { Walk } from "./walk";

/** Every class this renderer writes, besides the colour classes and rich.ts's rich-link. */
export const BLOCK_CLASSES: readonly string[] = [
  "nb-doc", "nb-p", "nb-h", "nb-list", "nb-li", "nb-todo", "nb-todo-done", "nb-check", "nb-kids", "nb-quote",
  "nb-callout", "nb-callout-icon", "nb-callout-body", "nb-code", "nb-code-lang", "nb-caption", "nb-hr",
  "nb-marker", "nb-media", "nb-bookmark", "nb-page", "nb-db", "nb-equation", "nb-unsupported", "nb-error",
  "nb-cut", "nb-toggle", "nb-summary", "nb-table", "nb-columns", "nb-column", "nb-synced",
];
export const ALLOWED_CLASSES: ReadonlySet<string> = new Set([...BLOCK_CLASSES, ...COLOR_CLASSES, "rich-link"]);

const HEADING_TAG: Record<string, string> = { heading_1: "h3", heading_2: "h4", heading_3: "h5", heading_4: "h5" };
const MEDIA = new Set(["video", "audio", "file", "pdf"]);
const LINKS = new Set(["bookmark", "embed", "link_preview"]);
const MAX_EMOJI = 16;
const EXCERPT_BLOCKS = 100;
export const MAX_ROW_CELLS = 50;
export const MAX_TABLE_CELLS = 2000;

interface Env { ctx: RenderCtx; walk: Walk; depth: number }

function withColor(base: string, data: Record<string, unknown>): string {
  const c = colorClass(data.color);
  return c ? `${base} ${c}` : base;
}

function textEl(tag: string, cls: string, text: string): HTMLElement {
  const node = el(tag, cls);
  node.textContent = text;
  return node;
}

// ---------- layout: tables (50 cells per row, 2000 per table), columns, details ----------

type TableState = { colHeader: boolean; rowHeader: boolean; rows: number; cells: number };
const TABLES = new WeakMap<HTMLElement, TableState>();

function table(b: Record<string, unknown>, data: Record<string, unknown>, env: Env): HTMLElement {
  const t = el("table", "nb-table");
  TABLES.set(t, { colHeader: data.has_column_header === true, rowHeader: data.has_row_header === true, rows: 0, cells: 0 });
  env.walk.child(b, t, env.depth, null);
  return t;
}

/** A row goes into its table; outside one, or past the table's cell cap, it renders nothing. */
function tableRow(data: Record<string, unknown>, into: HTMLElement, ctx: RenderCtx): void {
  const state = TABLES.get(into);
  if (!state || state.cells >= MAX_TABLE_CELLS) return;
  const cells = Array.isArray(data.cells) ? data.cells.slice(0, MAX_ROW_CELLS) : [];
  const tr = el("tr", "");
  cells.forEach((cell, i) => {
    if (state.cells >= MAX_TABLE_CELLS) return;
    state.cells++;
    const head = (state.colHeader && state.rows === 0) || (state.rowHeader && i === 0);
    const td = el(head ? "th" : "td", "");
    appendRich(td, cell, ctx);
    tr.appendChild(td);
  });
  state.rows++;
  into.appendChild(tr);
}

function columns(b: Record<string, unknown>, type: string, env: Env): HTMLElement {
  const box = el("div", type === "column_list" ? "nb-columns" : "nb-column");
  env.walk.child(b, box, env.depth, null);
  return box;
}

const SUMMARY_FALLBACK: Record<string, string> = { tab: "Tab", meeting_notes: "Meeting Notes", transcription: "Meeting Notes" };

/** A details element: toggles, toggleable headings and meeting notes load children on open; a tab eagerly. */
function detailsBlock(b: Record<string, unknown>, type: string, data: Record<string, unknown>, env: Env): HTMLElement {
  const details = el("details", withColor("nb-toggle", data)) as HTMLDetailsElement;
  const summary = el("summary", "nb-summary");
  const title = Array.isArray(data.rich_text) ? data.rich_text : data.title;
  if (type in HEADING_TAG) {
    const h = el(HEADING_TAG[type], "nb-h");
    appendRich(h, title, env.ctx);
    summary.appendChild(h);
  } else if (plainText(title).trim()) {
    appendRich(summary, title, env.ctx);
  } else {
    summary.textContent = SUMMARY_FALLBACK[type] ?? "Toggle";
  }
  details.appendChild(summary);
  const kids = el("div", "nb-kids");
  details.appendChild(kids);
  env.walk.child(b, kids, env.depth, details);
  return details;
}

// ---------- content blocks ----------

function payload(b: Record<string, unknown>): Record<string, unknown> {
  return rec(b[str(b.type)]) ?? {};
}

function marker(label: string): HTMLElement {
  return textEl("span", "nb-marker", label);
}

function unsupported(): HTMLElement {
  const box = el("div", "nb-unsupported");
  box.appendChild(marker("Unsupported Block"));
  return box;
}

function caption(box: HTMLElement, data: Record<string, unknown>, ctx: RenderCtx): void {
  if (!Array.isArray(data.caption) || data.caption.length === 0) return;
  const line = el("p", "nb-caption");
  appendRich(line, data.caption, ctx);
  box.appendChild(line);
}

function listFor(into: HTMLElement, tag: "ul" | "ol"): HTMLElement {
  const last = into.lastElementChild;
  if (last instanceof HTMLElement && last.tagName.toLowerCase() === tag && last.classList.contains("nb-list")) return last;
  const list = el(tag, "nb-list");
  into.appendChild(list);
  return list;
}

function richBlock(tag: string, cls: string, data: Record<string, unknown>, ctx: RenderCtx): HTMLElement {
  const node = el(tag, withColor(cls, data));
  appendRich(node, data.rich_text, ctx);
  return node;
}

function callout(b: Record<string, unknown>, data: Record<string, unknown>, env: Env): HTMLElement {
  const box = el("div", withColor("nb-callout", data));
  const icon = rec(data.icon);
  if (icon && icon.type === "emoji" && typeof icon.emoji === "string" && icon.emoji.length <= MAX_EMOJI) {
    box.appendChild(textEl("span", "nb-callout-icon", icon.emoji));
  }
  const body = el("div", "nb-callout-body");
  body.appendChild(richBlock("p", "nb-p", { rich_text: data.rich_text }, env.ctx));
  box.appendChild(body);
  env.walk.child(b, body, env.depth, null);
  return box;
}

function media(type: string, data: Record<string, unknown>, ctx: RenderCtx): HTMLElement {
  const box = el("div", "nb-media");
  const name = type === "image" ? "" : str(data.name).trim();
  box.appendChild(marker(type === "image" ? "Image" : name || "File"));
  caption(box, data, ctx);
  return box;
}

function linkBlock(data: Record<string, unknown>, ctx: RenderCtx): HTMLElement {
  const url = str(data.url);
  if (!url) return unsupported();
  const box = el("div", "nb-bookmark");
  // labelled with the safe url, never the raw one; an unsafe url shows as its stripped text, inert
  box.appendChild(inertLink(safeUrl(url) ?? url, url, (u) => ctx.openUrl(u)));
  caption(box, data, ctx);
  return box;
}

/** One block's element, or null when it went into a container already in `into` (list items). */
function blockEl(b: Record<string, unknown>, into: HTMLElement, env: Env): HTMLElement | null {
  const type = str(b.type);
  const data = payload(b);
  const ctx = env.ctx;
  if (type in HEADING_TAG && data.is_toggleable !== true) return richBlock(HEADING_TAG[type], "nb-h", data, ctx);
  if (type in HEADING_TAG || type === "toggle" || type === "tab" || type === "meeting_notes" || type === "transcription") {
    return detailsBlock(b, type, data, env);
  }
  switch (type) {
    case "table":
      return table(b, data, env);
    case "table_row":
      tableRow(data, into, ctx);
      return null;
    case "column_list":
    case "column":
      return columns(b, type, env);
    case "paragraph":
      return richBlock("p", "nb-p", data, ctx);
    case "bulleted_list_item":
    case "numbered_list_item": {
      const li = richBlock("li", "nb-li", data, ctx);
      listFor(into, type === "bulleted_list_item" ? "ul" : "ol").appendChild(li);
      env.walk.child(b, li, env.depth, null);
      return null;
    }
    case "to_do": {
      const done = data.checked === true;
      const box = el("div", withColor(done ? "nb-todo nb-todo-done" : "nb-todo", data));
      // el() has no input tag, so the checkbox state is a text marker
      box.appendChild(textEl("span", "nb-check", done ? "☑" : "☐"));
      const text = el("span", "");
      appendRich(text, data.rich_text, ctx);
      box.appendChild(text);
      const kids = el("div", "nb-kids");
      box.appendChild(kids);
      env.walk.child(b, kids, env.depth, null);
      return box;
    }
    case "quote": {
      const q = richBlock("blockquote", "nb-quote", data, ctx);
      env.walk.child(b, q, env.depth, null);
      return q;
    }
    case "callout":
      return callout(b, data, env);
    case "synced_block": {
      const box = el("div", "nb-synced");
      env.walk.child(b, box, env.depth, null);
      return box;
    }
    case "code": {
      const box = el("div", "nb-code");
      const lang = str(data.language);
      if (lang) box.appendChild(textEl("div", "nb-code-lang", lang));
      const pre = el("pre", "");
      pre.appendChild(textEl("code", "", plainText(data.rich_text)));
      box.appendChild(pre);
      caption(box, data, ctx);
      return box;
    }
    case "divider":
      return el("hr", "nb-hr");
    case "equation": {
      const box = el("div", "nb-equation");
      box.appendChild(textEl("code", "", str(data.expression)));
      return box;
    }
    case "image":
      return media(type, data, ctx);
    case "child_page":
      return textEl("div", "nb-page", str(data.title).trim() || "Untitled");
    case "child_database": {
      const box = el("div", "nb-db");
      box.appendChild(marker("Database"));
      const title = str(data.title).trim();
      if (title) box.appendChild(textEl("span", "", title));
      return box;
    }
    default:
      if (MEDIA.has(type)) return media(type, data, ctx);
      if (LINKS.has(type)) return linkBlock(data, ctx);
      return unsupported();
  }
}

/** The walk's placer: renders blocks into `into` and hands blocks with children back to the walk. */
export function placeBlocks(blocks: Record<string, unknown>[], into: HTMLElement, depth: number, walk: Walk, ctx: RenderCtx): void {
  const env: Env = { ctx, walk, depth };
  for (const b of blocks) {
    const node = blockEl(b, into, env);
    if (node) into.appendChild(node);
  }
}

/** Renders a body and returns the walk too (callers and tests await `walk.idle`). */
export function renderDoc(doc: unknown, ctx: RenderCtx): { el: HTMLElement; walk: Walk | null; fellBack: false | { reason: string } } {
  const root = el("div", "nb-doc");
  const d = rec(doc);
  if (!d || typeof d.pageId !== "string" || !Array.isArray(d.blocks)) {
    root.appendChild(unsupported());
    return { el: root, walk: null, fellBack: { reason: "Not a Notion page body" } };
  }
  const walk = new Walk(root, (id, cursor) => ctx.loadChildren(id, cursor), () => ctx.alive(),
    (blocks, into, depth, w) => placeBlocks(blocks, into, depth, w, ctx));
  walk.start(d.pageId, d.blocks, typeof d.next === "string" ? d.next : null);
  return { el: root, walk, fellBack: false };
}

function blockText(b: unknown): string {
  const r = rec(b);
  if (!r) return "";
  const data = payload(r);
  if (r.type === "child_page" || r.type === "child_database") return str(data.title);
  return plainText(data.rich_text);
}

export const notionRenderer: RichRenderer = {
  render(doc, ctx) {
    const { el: node, fellBack } = renderDoc(doc, ctx);
    return { el: node, fellBack };
  },
  excerpt(doc, max) {
    const blocks = rec(doc)?.blocks;
    if (!Array.isArray(blocks) || max <= 0) return "";
    const parts: string[] = [];
    let len = 0;
    for (const b of blocks.slice(0, EXCERPT_BLOCKS)) {
      const t = blockText(b).replace(/\s+/g, " ").trim();
      if (!t) continue;
      parts.push(t);
      len += t.length + 1;
      if (len > max) break;
    }
    return Array.from(parts.join(" ")).slice(0, max).join("");
  },
};
