// src\runes\bare\progress.ts — pure reducer for the `rules-generate-progress` events of a chunked Create Runes run
// (run 2026-10-18-rune-gen-per-source, plan § Progress events). No DOM, no IPC: events in, rows out.

export interface ProgressPart { k: number; of: number }
export interface ProgressFile { path: string; part: ProgressPart | null }
export type ChunkState = "running" | "retrying" | "done" | "failed" | "stopped";
export type MergeState = "running" | "done" | "failed";

export type ProgressEvent =
  | { runId: string; stage: "plan"; chunks: { files: ProgressFile[] }[] }
  | { runId: string; stage: "chunk"; index: number; state: ChunkState; runes: number | null }
  | { runId: string; stage: "merge"; state: MergeState };

export type RowState = "pending" | "running" | "done" | "failed" | "stopped";
export interface ProgressRow { label: string; state: RowState; text: string }

/** `startedAt` is the frontend clock (ms) when the row first went running; null until then. */
interface ChunkEntry { files: ProgressFile[] | null; state: ChunkState | null; runes: number | null; startedAt: number | null }
export interface ProgressState { chunks: ChunkEntry[]; merge: MergeState | null; mergeStartedAt: number | null; stopped: boolean }

export const emptyProgress = (): ProgressState => ({ chunks: [], merge: null, mergeStartedAt: null, stopped: false });

/** Pure: the label of a chunk: its files' paths joined ", ". A split file's part number is not shown: its
 *  cards already stand one per part (2026-10-18). */
export const chunkLabel = (files: readonly ProgressFile[]): string => files.map((f) => f.path).join(", ");

const blank = (): ChunkEntry => ({ files: null, state: null, runes: null, startedAt: null });

/** Pure: fold one event into the state (a new object). A `chunk` event ahead of `plan` creates its row.
 *  `now` is the frontend clock in ms: a row's start time is the first event that sets it running or retrying. */
export function reduceProgress(s: ProgressState, e: ProgressEvent, now: number = Date.now()): ProgressState {
  const chunks = s.chunks.map((c) => ({ ...c }));
  if (e.stage === "plan") {
    e.chunks.forEach((c, i) => { (chunks[i] ??= blank()).files = c.files; });
    return { ...s, chunks };
  }
  if (e.stage === "chunk") {
    while (chunks.length <= e.index) chunks.push(blank());
    chunks[e.index].state = e.state;
    chunks[e.index].runes = e.runes;
    if (chunks[e.index].startedAt === null && (e.state === "running" || e.state === "retrying")) chunks[e.index].startedAt = now;
    return { ...s, chunks };
  }
  return { ...s, chunks, merge: e.state, mergeStartedAt: s.mergeStartedAt ?? (e.state === "running" ? now : null) };
}

/** Pure: a final error or cancel: every row not done or failed reads Stopped. */
export function stopProgress(s: ProgressState): ProgressState {
  return { ...s, stopped: true };
}

const runesText = (n: number | null): string => (n === 1 ? "1 Rune" : n === null ? "Done" : `${n} Runes`);

/** Pure: the rows to draw: one per chunk, then "Merge" when there is more than one chunk. */
export function progressRows(s: ProgressState): ProgressRow[] {
  const rest = (st: RowState): RowState => (s.stopped && (st === "pending" || st === "running") ? "stopped" : st);
  const rows: ProgressRow[] = s.chunks.map((c, i) => {
    const label = c.files ? chunkLabel(c.files) : `Chunk ${i + 1}`;
    const raw: RowState = c.state === null ? "pending" : c.state === "retrying" ? "running" : c.state;
    const state = rest(raw);
    let text = "";
    if (state === "stopped") text = "Stopped";
    else if (c.state === "done") text = runesText(c.runes);
    else if (c.state === "retrying") text = "Retrying";
    else if (c.state === "failed") text = "Failed";
    return { label, state, text };
  });
  if (s.chunks.length > 1) {
    const state = rest(s.merge ?? "pending");
    const text = state === "stopped" ? "Stopped" : state === "done" ? "Done" : state === "failed" ? "Failed" : "";
    rows.push({ label: "Merge", state, text });
  }
  return rows;
}

/** Pure: "m:ss" from a millisecond span (never negative). */
export const elapsedLabel = (ms: number): string => {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
};

/** A drawn card: the row, its Retrying flag and its start time while it is running (null otherwise). */
export interface ProgressCard extends ProgressRow { retrying: boolean; startedAt: number | null }

/** Pure: `progressRows` plus what the cards need. A stopped row keeps no timer. */
export function progressCards(s: ProgressState): ProgressCard[] {
  const rows = progressRows(s);
  return rows.map((r, i) => {
    const merge = i >= s.chunks.length;
    const started = merge ? s.mergeStartedAt : s.chunks[i].startedAt;
    const retrying = !merge && r.state === "running" && s.chunks[i].state === "retrying";
    return { ...r, retrying, startedAt: r.state === "running" ? started : null };
  });
}
