// Notion rich text -> DOM (docs/projects/notion/plan.md § Views › Blocks). Remote strings land only in
// textContent; annotations map to fixed tags, Notion colours to a fixed class list, links and mention
// hrefs to inert links (http/https only reach ctx.openUrl). Mentions render their plain_text.
import { el, inertLink } from "../browser/rich";
import type { RenderCtx } from "../browser/types";

const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const COLOR_SET = new Set(COLORS);

/** Every class a Notion colour can map to. */
export const COLOR_CLASSES: readonly string[] = COLORS.flatMap((c) => [`nb-c-${c}`, `nb-bg-${c}`]);

/** Segments read per rich-text array (Notion sends at most 100). */
const MAX_SEGMENTS = 200;

export function rec(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

export function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

/** "red" -> nb-c-red, "red_background" -> nb-bg-red; default and anything unknown -> "". */
export function colorClass(color: unknown): string {
  const c = str(color);
  const bg = c.endsWith("_background");
  const name = bg ? c.slice(0, -"_background".length) : c;
  if (!COLOR_SET.has(name)) return "";
  return bg ? `nb-bg-${name}` : `nb-c-${name}`;
}

function segments(rt: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rt)) return [];
  const out: Record<string, unknown>[] = [];
  for (const s of rt.slice(0, MAX_SEGMENTS)) {
    const r = rec(s);
    if (r) out.push(r);
  }
  return out;
}

function segmentText(s: Record<string, unknown>): string {
  if (typeof s.plain_text === "string") return s.plain_text;
  const t = rec(s.text);
  if (t) return str(t.content);
  const eq = rec(s.equation);
  return eq ? str(eq.expression) : "";
}

/** A relative internal link: "/" then a 32-hex id, dashed or not, then nothing or a query or fragment. */
const INTERNAL = /^\/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#].*)?$/i;

/** "/<32hex>" -> https://www.notion.so/<32hex>; any other relative link stays as is (rendered plain). */
export function absoluteHref(href: string): string {
  const m = INTERNAL.exec(href);
  return m ? `https://www.notion.so/${m[1].replace(/-/g, "").toLowerCase()}` : href;
}

function segmentUrl(s: Record<string, unknown>): string {
  if (s.type === "text") {
    const link = rec(rec(s.text)?.link);
    if (link && typeof link.url === "string") return absoluteHref(link.url);
  }
  return absoluteHref(str(s.href));
}

/** The plain text of a rich-text array. */
export function plainText(rt: unknown): string {
  return segments(rt).map(segmentText).join("");
}

function wrap(inner: Node, tag: string, cls: string): Node {
  const node = el(tag, cls);
  node.appendChild(inner);
  return node;
}

function segmentNode(s: Record<string, unknown>, ctx: RenderCtx): Node {
  const text = segmentText(s);
  const url = segmentUrl(s);
  let node: Node = url ? inertLink(text, url, (u) => ctx.openUrl(u)) : document.createTextNode(text);
  const a = rec(s.annotations) ?? {};
  if (s.type === "equation" || a.code === true) node = wrap(node, "code", "");
  if (a.strikethrough === true) node = wrap(node, "s", "");
  if (a.underline === true) node = wrap(node, "u", "");
  if (a.italic === true) node = wrap(node, "em", "");
  if (a.bold === true) node = wrap(node, "strong", "");
  const cls = colorClass(a.color);
  if (cls) node = wrap(node, "span", cls);
  return node;
}

/** Appends a rich-text array to `parent`. */
export function appendRich(parent: HTMLElement, rt: unknown, ctx: RenderCtx): void {
  for (const s of segments(rt)) parent.appendChild(segmentNode(s, ctx));
}
