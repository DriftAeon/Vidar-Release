// The shared browser shell's contract (docs/projects/notion/plan.md § Shell interface and § v1 → v2 delta).
// Types only: a source (Notion first, Jira next) maps its rows to `Item`s and hands the shell an `Adapter`.

import type { LucideName } from "../icons";

export type Tone ="todo" | "progress" | "review" | "blocked" | "done" | "neutral";

export interface Field { label: string; value: string; dim?: boolean }

/** The facet value a band stands for; the status strip toggles it. Optional: Jira bands omit it. */
export interface GroupFacet { id: string; value: string }

export interface Group { id: string; label: string; tone: Tone; rank: number; facet?: GroupFacet }

/** A row's leading mark: the page's own emoji, a named glyph, or a blank slot that keeps titles aligned. */
export type Lead = { emoji: string } | { glyph: LucideName } | { blank: true };

export interface ItemTag { label: string; tone: Tone }

export interface Item {
  id: string;
  /** Empty renders no key span. */
  key: string;
  title: string;
  /** Group value or ""; an empty status hides the pill. */
  status: string;
  updated: string;
  group?: Group;
  /** Optional mark before the key (Notion page icons). */
  lead?: Lead;
  /** Optional value pills before Send (Notion tags), at most two. */
  tags?: ItemTag[];
  /** The row's tooltip (title attribute). */
  tip?: string;
  /** Facet id -> the values this item holds. An `age` facet holds one ISO timestamp. */
  facets: Record<string, string[]>;
  fields: Field[];
}

export interface Facet {
  id: string;
  label: string;
  place: "top" | "more";
  kind: "multi" | "age";
  valueLabel(v: string): string;
}

export interface Comments {
  total: number;
  items: { author: string; when: string; body: unknown }[];
  more: boolean;
}

export interface Section { title: string; rows: { relation?: string; item: Item }[] }

export interface Detail {
  extraFields: Field[];
  excerpt: string;
  body: unknown;
  sections: Section[];
  comments: Comments;
}

export type Loaded<T> = { ok: T } | { error: { title: string; message: string } };

/** What a renderer may call back into (B2). `render` stays synchronous; later fills check `alive()` first. */
export interface RenderCtx {
  /** http/https only, through `open_url`. */
  openUrl(url: string): void;
  loadChildren(id: string, cursor: string | null): Promise<Loaded<{ blocks: unknown[]; next: string | null }>>;
  /** Generation unchanged and target connected. */
  alive(): boolean;
}

export interface RichRenderer {
  render(doc: unknown, ctx: RenderCtx): { el: HTMLElement; fellBack: false | { reason: string } };
  excerpt(doc: unknown, max: number): string;
}

export interface Adapter {
  source: string;
  noun: string;
  rich: RichRenderer;
  /** Send's tooltip; "Send" when unset. The accessible name stays "Send". */
  sendTip?: string;
  load(item: Item): Promise<Loaded<Detail>>;
  moreComments(item: Item, from: number): Promise<Loaded<Comments>>;
  send(item: Item): void;
  open(item: Item): void;
  /** Rich links call this, never `open(item)` (B1). http/https only. */
  openUrl(url: string): void;
  /** Optional (Jira omits it); the shell's RenderCtx.loadChildren comes from it. */
  loadChildren?(id: string, cursor: string | null): Promise<Loaded<{ blocks: unknown[]; next: string | null }>>;
  /** Row click, Enter or Space first; true = handled (D11). */
  activate?(item: Item): boolean;
  /** Esc with nothing open (D11). */
  back?(): void;
  /** The source's connection generation; a RenderCtx is alive only while it is unchanged (B2). */
  generation?(): number;
}

export interface Browser {
  root: HTMLElement;
  setItems(items: Item[], facets: Facet[], s: { busy: boolean; note: string | null }): void;
  /** Connection changed: closes Fullscreen, collapses the card, drops built cards, ends every RenderCtx. */
  reset(): void;
  dispose(): void;
}

export type BuildBrowser = (adapter: Adapter, head: HTMLElement) => Browser;
