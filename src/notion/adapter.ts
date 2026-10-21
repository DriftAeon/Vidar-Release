// The Notion `Adapter` for the shared browser (docs/projects/notion/plan.md D1, § Views › Card and Fullscreen, S3).
// A card's load costs two requests: notion_page for the fields, then the first notion_blocks page for the
// excerpt; `body` is { pageId, blocks, next } and Fullscreen walks the rest through loadChildren. Details are
// cached (at most 100, keyed id + lastEdited) with one promise in flight per key; a reply that lands after the
// generation moved is returned but never kept. Links open through open_url (http/https only).
import { invoke } from "../ipc";
import { safeUrl } from "../browser/rich";
import { cleanSend } from "../browser/send";
import type { Adapter, Comments, Detail, Item, Loaded } from "../browser/types";
import { notionRenderer } from "./blocks";
import { call, currentGen } from "./fetch";
import { SEND_TIP, errorCopy, fallbackUrl, pageFields, subpageItems } from "./model";

export const MAX_DETAILS = 100;
export const EXCERPT_CHARS = 400;
export const SEND_BYTES = 1024;

const NO_COMMENTS: Comments = { total: 0, items: [], more: false };

/** Key -> the load and the generation it started in; an entry from an older generation is a miss. */
const details = new Map<string, { p: Promise<Loaded<Detail>>; gen: number }>();
/** Page and data-source id -> its Notion url, from every list and page reply. */
const links = new Map<string, string>();
/** Ids that drill in (data sources) instead of opening a card. */
const sources = new Set<string>();

export function rememberLinks(entries: Iterable<{ id: string; url: string; source?: boolean }>): void {
  for (const e of entries) {
    if (e.url) links.set(e.id, e.url);
    if (e.source) sources.add(e.id);
  }
}
export const isSource = (id: string): boolean => sources.has(id);
export const linkFor = (id: string): string => links.get(id) ?? fallbackUrl(id);
export const detailCount = (): number => details.size;

/** Disconnect: forget every detail, link and data-source id. */
export function clearAdapterState(): void {
  details.clear();
  links.clear();
  sources.clear();
}

export function openLink(url: string): void {
  const ok = safeUrl(url);
  if (ok) void invoke("open_url", { url: ok }).catch(() => undefined);
}

async function fetchDetail(item: Item, mine: number): Promise<Loaded<Detail>> {
  const p = await call(() => invoke("notion_page", { id: item.id }));
  if ("error" in p) return { error: errorCopy(p.error) };
  if (currentGen() === mine) rememberLinks([{ id: item.id, url: p.ok.page.url }]);
  const b = await call(() => invoke("notion_blocks", { id: item.id, cursor: null }));
  if ("error" in b) return { error: errorCopy(b.error) };
  const page = p.ok.page;
  const blocks = Array.isArray(b.ok.blocks) ? b.ok.blocks : [];
  const body = { pageId: page.id, blocks, next: typeof b.ok.next === "string" ? b.ok.next : null };
  const subpages = subpageItems(blocks);
  return {
    ok: {
      extraFields: pageFields(page, item),
      excerpt: notionRenderer.excerpt(body, EXCERPT_CHARS),
      body,
      sections: subpages.length ? [{ title: "Subpages", rows: subpages.map((s) => ({ item: s })) }] : [],
      comments: NO_COMMENTS,
    },
  };
}

/** Cached load: hit -> the same promise (moved to newest); miss -> one request pair, kept only while the
 *  generation is unchanged and the reply is not an error. */
export function loadDetail(item: Item): Promise<Loaded<Detail>> {
  const key = `${item.id}|${item.updated}`;
  const mine = currentGen();
  const hit = details.get(key);
  details.delete(key);
  if (hit && hit.gen === mine) {
    details.set(key, hit);
    return hit.p;
  }
  const p: Promise<Loaded<Detail>> = fetchDetail(item, mine).then((r) => {
    if ((currentGen() !== mine || "error" in r) && details.get(key)?.p === p) details.delete(key);
    return r;
  });
  details.set(key, { p, gen: mine });
  while (details.size > MAX_DETAILS) details.delete(details.keys().next().value as string);
  return p;
}

const encoder = new TextEncoder();

/** "<title> <url>" within SEND_BYTES: the title is cut to fit, never the url. */
export function sendText(title: string, url: string): string {
  const link = cleanSend(url, SEND_BYTES);
  const room = SEND_BYTES - encoder.encode(link).length - 1;
  const head = room > 0 ? cleanSend(title, room) : "";
  return head ? `${head} ${link}` : link;
}

export interface AdapterHooks {
  /** A data-source row was activated. */
  drill(item: Item): void;
  /** Esc at rest on the data-source level. */
  back?(): void;
  /** Hands the send text to the focused tab. */
  type(text: string): void;
}

export function makeAdapter(source: string, h: AdapterHooks): Adapter {
  const a: Adapter = {
    source,
    noun: "Pages",
    rich: notionRenderer,
    sendTip: SEND_TIP,
    load: (item) => loadDetail(item),
    moreComments: async () => ({ ok: NO_COMMENTS }),
    send: (item) => h.type(sendText(item.title, linkFor(item.id))),
    generation: currentGen,
    open: (item) => openLink(linkFor(item.id)),
    openUrl: (url) => openLink(url),
    loadChildren: async (id, cursor) => {
      const r = await call(() => invoke("notion_blocks", { id, cursor }));
      if ("error" in r) return { error: errorCopy(r.error) };
      return { ok: { blocks: Array.isArray(r.ok.blocks) ? r.ok.blocks : [], next: typeof r.ok.next === "string" ? r.ok.next : null } };
    },
    activate: (item) => {
      if (!sources.has(item.id)) return false;
      h.drill(item);
      return true;
    },
  };
  if (h.back) {
    const back = h.back;
    a.back = () => back();
  }
  return a;
}
