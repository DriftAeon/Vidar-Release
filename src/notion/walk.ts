// The Notion block walk (docs/projects/notion/plan.md § Views › Blocks, D7, S6). One request at a time
// through an injected fetcher (no ipc here): further pages of a container, eager children, and lazy
// children queued when their details opens. Caps per page: 60 requests (the first page included) and 3000
// blocks stop the walk; the root's children are depth 1, and past depth 6 only that subtree is skipped.
// Either shows the cut note once. It stops at the first error (with a root note when work was still
// queued) and whenever alive() is false.
import { el } from "../browser/rich";
import type { Loaded } from "../browser/types";
import { rec, str } from "./rich-text";

export type Page = { blocks: unknown[]; next: string | null };
export type Fetcher = (id: string, cursor: string | null) => Promise<Loaded<Page>>;
/** Renders blocks into a container; calls walk.child for each block whose children it wants. */
export type Placer = (blocks: Record<string, unknown>[], into: HTMLElement, depth: number, walk: Walk) => void;

export const MAX_REQUESTS = 60;
export const MAX_DEPTH = 6;
export const MAX_BLOCKS = 3000;

const CUT_NOTE = "Part of this page is not shown. Open it in Notion to see the rest."; // note-ok: docs/projects/notion/plan.md
const LOAD_ERROR = "Couldn't Load This Part";
const PARTIAL_NOTE = "Couldn't Load All of This Page."; // note-ok: docs/projects/notion/plan.md

const EAGER = new Set([
  "bulleted_list_item", "numbered_list_item", "to_do", "quote", "callout", "column_list", "column", "table",
  "synced_block", "tab",
]);
const LAZY = new Set(["toggle", "meeting_notes", "transcription"]);
const HEADINGS = new Set(["heading_1", "heading_2", "heading_3", "heading_4"]);

/** How a block's children load: now, when its details opens, or never. */
export function childMode(block: Record<string, unknown>): "eager" | "lazy" | "none" {
  if (block.has_children !== true) return "none";
  const type = str(block.type);
  if (EAGER.has(type)) return "eager";
  if (LAZY.has(type)) return "lazy";
  if (HEADINGS.has(type) && rec(block[type])?.is_toggleable === true) return "lazy";
  return "none";
}

/** The id whose children a block shows: a synced duplicate's original, else the block itself. */
export function childSource(block: Record<string, unknown>): string {
  if (block.type === "synced_block") {
    const from = str(rec(rec(block.synced_block)?.synced_from)?.block_id);
    if (from) return from;
  }
  return str(block.id);
}

type Task = { id: string; cursor: string | null; into: HTMLElement; depth: number };

export class Walk {
  requests = 0;
  blocks = 0;
  stopped = false;
  private queue: Task[] = [];
  private running = false;
  private visited = new Set<string>();
  private noted = false;
  private readonly noteEl = el("p", "nb-cut");
  /** Settles when the queue drains or the walk stops (tests and callers await it). */
  idle: Promise<void> = Promise.resolve();

  private readonly root: HTMLElement;
  private readonly fetch: Fetcher;
  private readonly alive: () => boolean;
  private readonly place: Placer;

  constructor(root: HTMLElement, fetch: Fetcher, alive: () => boolean, place: Placer) {
    this.root = root;
    this.fetch = fetch;
    this.alive = alive;
    this.place = place;
  }

  /** Places a page's first blocks (the root's children, depth 1) and queues the rest of it. The first page
   *  was one request (the adapter's load), so it counts toward MAX_REQUESTS. */
  start(pageId: string, blocks: unknown[], next: string | null): void {
    this.visited.add(pageId);
    this.requests++;
    this.put(blocks, this.root, 1);
    this.more(pageId, next, this.root, 1, blocks.length);
    this.pump();
  }

  /** Called by the placer for a block with children, `into` being where they go. */
  child(block: Record<string, unknown>, into: HTMLElement, depth: number, opener: HTMLDetailsElement | null): void {
    const mode = childMode(block);
    if (mode === "none" || this.stopped) return;
    const id = childSource(block);
    if (!id) return;
    if (mode === "eager" || !opener) {
      this.enqueue(id, into, depth + 1);
      return;
    }
    const open = (): void => {
      if (!opener.open) return;
      opener.removeEventListener("toggle", open);
      this.enqueue(id, into, depth + 1);
      this.pump();
    };
    opener.addEventListener("toggle", open);
  }

  private enqueue(id: string, into: HTMLElement, depth: number): void {
    if (this.stopped || this.visited.has(id)) return;
    // depth cap: only this subtree is skipped; siblings keep loading
    if (depth > MAX_DEPTH) return this.note();
    this.visited.add(id);
    this.queue.push({ id, cursor: null, into, depth });
  }

  private more(id: string, next: string | null, into: HTMLElement, depth: number, got: number): void {
    // paging ends on an absent cursor or an empty page that still carries one
    if (typeof next === "string" && next !== "" && got > 0) this.queue.push({ id, cursor: next, into, depth });
  }

  private put(blocks: unknown[], into: HTMLElement, depth: number): void {
    const list: Record<string, unknown>[] = [];
    for (const b of blocks) {
      const r = rec(b);
      if (!r) continue;
      if (this.blocks >= MAX_BLOCKS) {
        this.place(list, into, depth, this);
        return this.cut();
      }
      this.blocks++;
      list.push(r);
    }
    this.place(list, into, depth, this);
    if (this.noted && into === this.root) this.root.appendChild(this.noteEl);
  }

  private pump(): void {
    if (this.running || this.stopped || this.queue.length === 0) return;
    this.running = true;
    this.idle = this.run().finally(() => { this.running = false; });
  }

  private async run(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      if (!this.alive()) return this.halt();
      if (this.requests >= MAX_REQUESTS || this.blocks >= MAX_BLOCKS) return this.cut();
      const t = this.queue.shift() as Task;
      this.requests++;
      let r: Loaded<Page>;
      try {
        r = await this.fetch(t.id, t.cursor);
      } catch {
        r = { error: { title: LOAD_ERROR, message: "" } };
      }
      if (!this.alive()) return this.halt();
      const ok = "ok" in r ? rec(r.ok) : null;
      if (!ok || !Array.isArray(ok.blocks)) {
        const line = el("p", "nb-error");
        line.textContent = LOAD_ERROR;
        t.into.appendChild(line);
        // later work is dropped and the line may sit in a closed toggle: say so at the root too
        if (this.queue.length > 0) {
          const note = el("p", "nb-error");
          note.textContent = PARTIAL_NOTE;
          this.root.appendChild(note);
        }
        return this.halt();
      }
      this.put(ok.blocks, t.into, t.depth);
      if (this.stopped) return;
      this.more(t.id, typeof ok.next === "string" ? ok.next : null, t.into, t.depth, ok.blocks.length);
    }
  }

  private halt(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  /** Request or block cap: the whole walk stops. */
  private cut(): void {
    this.halt();
    this.note();
  }

  /** The cut note, once, kept last in the root while later pages still land there. */
  private note(): void {
    if (this.noted) return;
    this.noted = true;
    this.noteEl.textContent = CUT_NOTE;
    this.root.appendChild(this.noteEl);
  }
}
