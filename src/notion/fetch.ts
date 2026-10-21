// The Notion paging loops (docs/projects/notion/plan.md D1, § Adapter rules, S1, S6): two searches for the top
// level and one query per data source, one request per IPC call, run in sequence. A loop stops on an absent or
// null cursor, at MAX_PAGES, on an empty page that still has a cursor, and on its first error. A reply with
// propsRefused drops filter_properties for that source from then on. The generation counter is bumped on
// Disconnect, dispose and level change: a loop that sees it move returns null and writes nothing. The stale
// stamp (10 min) is set only once the last page of a level has landed; the attempt stamp, which gates the
// show-time reload, on every load that finished (success or error), so a failing level is not polled.
import { invoke } from "../ipc";
import type { NotionHit, NotionReply, NotionRow, NotionSource } from "./ipc";
import { planFor, type Plan } from "./facets";
import type { NotionErr } from "./model";

export const MAX_PAGES = 20;
export const STALE_MS = 10 * 60_000;
export const TOP = "top";

let generation = 0;
export const currentGen = (): number => generation;
export function bumpGen(): void { generation++; }

const stamps = new Map<string, number>();
/** True when `key` ("top" or a data-source id) has never fully loaded, or did so over 10 min ago. */
export function isStale(key: string, now = Date.now()): boolean {
  const t = stamps.get(key);
  return t === undefined || now - t > STALE_MS;
}
export function clearStamps(): void { stamps.clear(); tried.clear(); }

/** Last attempt per level, success or error (Jira's lastFetch): a show-time reload waits 10 min after it. */
const tried = new Map<string, number>();
export function markAttempt(key: string, now = Date.now()): void { tried.set(key, now); }
/** True when `key` was never attempted, or its last attempt is 10 min or more old. */
export function dueOnShow(key: string, now = Date.now()): boolean {
  const t = tried.get(key);
  return t === undefined || now - t >= STALE_MS;
}

const refused = new Set<string>();
export const propsRefused = (id: string): boolean => refused.has(id);
export function clearRefused(): void { refused.clear(); }

export type Got<T> = { ok: T } | { error: NotionErr };

/** One IPC call: a reply's error, or a rejected invoke as a network error. */
export async function call<T>(run: () => Promise<NotionReply<T>>): Promise<Got<T>> {
  try {
    const r = await run();
    if (typeof r === "object" && r !== null && "error" in r) return { error: (r as { error: NotionErr }).error };
    return { ok: r as T };
  } catch (e) {
    return { error: { kind: "network", message: e instanceof Error ? e.message : String(e) } };
  }
}

export interface Paged<T> { items: T[]; capped: boolean; error: NotionErr | null }

type Step<T> = (cursor: string | null) => Promise<Got<{ items: T[]; next: string | null }>>;

/** Pages until a stop rule fires; null when the generation moved or `alive()` went false (nothing kept). */
export async function pageAll<T extends { id: string }>(step: Step<T>, alive: () => boolean): Promise<Paged<T> | null> {
  const mine = generation;
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const r = await step(cursor);
    if (mine !== generation || !alive()) return null;
    if ("error" in r) return { items, capped: false, error: r.error };
    for (const it of r.ok.items) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
    const next = r.ok.next;
    if (typeof next !== "string" || next === "" || r.ok.items.length === 0) return { items, capped: false, error: null };
    cursor = next;
  }
  return { items, capped: true, error: null };
}

const searchStep = (kind: "page" | "source"): Step<NotionHit> => async (cursor) => {
  const r = await call(() => invoke("notion_search", { kind, cursor }));
  return "error" in r ? r : { ok: { items: r.ok.hits, next: r.ok.next } };
};

export interface TopLoad { hits: NotionHit[]; capped: boolean; error: NotionErr | null }

/** Databases first, then pages; the first error ends the level (the page search is not sent). */
export async function loadTop(alive: () => boolean): Promise<TopLoad | null> {
  const mine = generation;
  const sources = await pageAll(searchStep("source"), alive);
  if (!sources) return null;
  if (sources.error) {
    markAttempt(TOP);
    return { hits: sources.items, capped: sources.capped, error: sources.error };
  }
  const pages = await pageAll(searchStep("page"), alive);
  if (!pages || mine !== generation) return null;
  markAttempt(TOP);
  if (!pages.error) stamps.set(TOP, Date.now());
  return { hits: [...sources.items, ...pages.items], capped: sources.capped || pages.capped, error: pages.error };
}

export interface SourceLoad { source: NotionSource | null; plan: Plan | null; rows: NotionRow[]; capped: boolean; error: NotionErr | null }

/** The schema (facets and filter_properties come from it), then the rows. */
export async function loadSource(id: string, alive: () => boolean): Promise<SourceLoad | null> {
  const mine = generation;
  const s = await call(() => invoke("notion_source", { id }));
  if (mine !== generation || !alive()) return null;
  if ("error" in s) {
    markAttempt(id);
    return { source: null, plan: null, rows: [], capped: false, error: s.error };
  }
  const plan = planFor(s.ok.source);
  const step: Step<NotionRow> = async (cursor) => {
    const props = refused.has(id) ? [] : plan.props;
    const r = await call(() => invoke("notion_query", { id, cursor, props }));
    if ("error" in r) return r;
    if (r.ok.propsRefused) refused.add(id);
    return { ok: { items: r.ok.rows, next: r.ok.next } };
  };
  const rows = await pageAll(step, alive);
  if (!rows || mine !== generation) return null;
  markAttempt(id);
  if (!rows.error) stamps.set(id, Date.now());
  return { source: s.ok.source, plan, rows: rows.items, capped: rows.capped, error: rows.error };
}
