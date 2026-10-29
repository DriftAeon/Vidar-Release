// src\runes\bare\progress.ts — pure reducer for the `rules-generate-progress` events of a chunked Create Runes run.
// No DOM, no IPC: events in, rows out. The result
// card's Add to Vault op lives here too, with `rune_vault_edit` passed in.

export interface ProgressPart { k: number; of: number }
/** `kind` is `rules` or `memory` (the plan event's `PlanFile.kind`); an event without it reads as rules. */
export interface ProgressFile { path: string; part: ProgressPart | null; kind?: string }
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

/** Pure: the label of a chunk: its files' paths joined ", ", a split file's part as ` - Chunk k of n`
 *  (without it a split file's rows read as duplicates). */
export const chunkLabel = (files: readonly ProgressFile[]): string =>
  files.map((f) => (f.part ? `${f.path} - Chunk ${f.part.k} of ${f.part.of}` : f.path)).join(", ");

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

/** The result card's action: puts the generated runeset (`gen-<runId>` / `generated-<yyyymmdd>`) in the tab's vault. */
export const ADD_TO_VAULT_LABEL = "Add to Vault";

/** What a landed generation names: its library and set (`RulesGenerated`). */
export interface GeneratedRef { library: string; set: string }

export type VaultEditOp = { op: "addRuneset"; ref: { library: string; set: string } };
export type VaultEditArgs = { id: string; ops: VaultEditOp[]; mode: "unlocked" };
/** `rune_vault_edit`, injected so this module stays IPC-free. */
export type VaultEdit = (a: VaultEditArgs) => Promise<unknown>;

/** Pure: the one op Add to Vault sends. */
export const addToVaultOps = (r: GeneratedRef): VaultEditOp[] => [{ op: "addRuneset", ref: { library: r.library, set: r.set } }];

/** Add to Vault on the tab's vault, unlocked mode only: a locked vault is refused by the store, whose error comes
 *  back as the text to show (the variant / edit-original choice comes later). `null` on success. */
export async function addToVault(edit: VaultEdit, vaultId: string | null, r: GeneratedRef): Promise<string | null> {
  if (!vaultId) return "This tab has no vault to add to.";
  try {
    await edit({ id: vaultId, ops: addToVaultOps(r), mode: "unlocked" });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

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

/** One chunk card inside a source frame, labelled "Chunk n" (its place in that source). A `twin` is the dashed copy of
 *  a chunk whose agent call also covers an earlier source: it mirrors the state glyph and shows no count or timer. */
export interface GroupCard { card: ProgressCard; twin: boolean }
export interface SourceFrame { path: string; cards: GroupCard[] }
export interface KindBand { kind: string; name: string; sources: SourceFrame[] }
export interface GroupedProgress { bands: KindBand[]; merge: ProgressCard | null }

const BAND_ORDER: [string, string][] = [["rules", "Rules"], ["memory", "Memories"]];

/** Pure: the chunk cards grouped kind band, then source frame, then card; Merge apart. Null (draw the flat list) for a
 *  run of one chunk or a chunk the plan has not named yet. Bands follow the Local Files order (Rules, Memories). A chunk
 *  covering several sources shows under each: live in the first, twin in the rest. */
export function groupedProgress(s: ProgressState): GroupedProgress | null {
  if (s.chunks.length < 2 || s.chunks.some((c) => !c.files || c.files.length === 0)) return null;
  const cards = progressCards(s);
  const bands = new Map<string, Map<string, GroupCard[]>>();
  s.chunks.forEach((c, i) => {
    const seen = new Set<string>();
    let first = true;
    for (const f of c.files ?? []) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      const kind = f.kind === "memory" ? "memory" : "rules";
      const frames = bands.get(kind) ?? new Map<string, GroupCard[]>();
      bands.set(kind, frames);
      const list = frames.get(f.path) ?? [];
      frames.set(f.path, list);
      const twin = !first;
      first = false;
      const card: ProgressCard = { ...cards[i], label: `Chunk ${list.length + 1}`, ...(twin ? { text: "", startedAt: null } : {}) };
      list.push({ card, twin });
    }
  });
  const out: KindBand[] = BAND_ORDER.filter(([k]) => bands.has(k)).map(([kind, name]) => ({
    kind, name, sources: [...bands.get(kind)!].map(([path, list]) => ({ path, cards: list })),
  }));
  return { bands: out, merge: cards.length > s.chunks.length ? cards[cards.length - 1] : null };
}
