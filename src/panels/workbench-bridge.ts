// Workbench bridge: publishes each Tray block to `bridge\workbench` and rebuilds the Tray from it
// at boot. Tray state and the block producers live in workbench-tray.ts and
// reach the restore through `TrayRestoreDeps`.

import { invoke } from "../ipc";
import { entryToRestore, blockToEntry, type BlockLike, type RestoreEntry, type Source } from "./workbench-restore";
import { releaseName } from "./workbench-names";

/** `transient`: the failure describes the world right now, not the block's
 *  own bytes — a read error (file moved/locked) or an admission refusal
 *  (tray full, over a size cap) may not hold on a later attempt. Only a
 *  restore reads it, to decide whether a failed entry is still worth keeping
 *  on disk (don't delete over something that might pass
 *  next time). */
export type Outcome = { ok: true } | { ok: false; reason: string; transient?: boolean };

/** identity a restored block keeps instead of getting a fresh name/timestamp */
export interface Restore { name: string; at: number; collapsed?: boolean; annotation?: string }

/** What the restore reads and calls in workbench-tray.ts: the name reservation, the note line,
 *  the block list and the three producers. */
export interface TrayRestoreDeps {
  reserveNames: (names: string[]) => void;
  note: (msg: string) => void;
  blocks: readonly { name: string; note: HTMLElement }[];
  addDroppedFile: (path: string, restore?: Restore) => Promise<Outcome>;
  addImageBlock: (blob: Blob, source: Source, file: undefined, restore?: Restore) => Promise<Outcome>;
  addTextBlock: (text: string, source: Source, restore?: Restore) => Outcome;
}

/* ---- workbench bridge ----
   Publish each block so a TAB can address it by name — "read Tray Alpha" —
   instead of the user reading a path out loud. One file per block under
   bridge\workbench (Rust: bridge.rs), written on add and deleted on remove.

   Text is inlined rather than materialised to bridge\clips. That keeps the
   tray's own rule intact (a path action saves a content block ONCE, and only
   when the user asks), and it is the only shape that serves the blocks worth
   handing to an agent: pasted text and marquee/OCR crops have no path at all
   until someone clicks Copy Path, so publishing paths alone would have exposed
   only the blocks that already had a one-click path.

   `at` pins identity alongside the name: `id` is a per-boot counter and names
   are reused after the alphabet wraps, so a consumer holding "Tray Delta" can
   tell it now means a different block.

   Persists across restarts: an image block with no path (a
   marquee/OCR crop, a pasted image) has no bytes on disk anywhere else, so
   publishing writes `<name>.png` alongside the entry — the only way a restore
   can get them back. A file block never does this: its path is already the
   bytes, and re-reading it is what restore does for that case instead. */

/** The entry JSON only; the fold republishes through this so no PNG is rewritten. */
export function publishEntry(b: BlockLike) {
  void invoke("write_workbench_entry", { name: b.name, json: JSON.stringify(blockToEntry(b)) }).catch(() => {});
}

export function publishBlock(b: BlockLike & { blob?: Blob }) {
  publishEntry(b);
  if (b.kind === "png" && !b.path && b.blob) {
    const blob = b.blob;
    void blob.arrayBuffer()
      .then((buf) => invoke("write_workbench_png", buf, { headers: { name: b.name } }))
      .catch(() => {});
  }
}

/* ---- restore ----
   Boot-time rebuild from `bridge\workbench`: the tray used to be cleared at
   startup because a stale entry naming a gone block was worse than none
   (bridge.rs). Now × deletes an entry the moment its block goes, so
   the set on disk IS the live set, and startup can trust it. */

export async function restoreTray(deps: TrayRestoreDeps) {
  const { reserveNames, note } = deps;
  let raw: string[];
  try {
    raw = await invoke("list_workbench_entries");
  } catch {
    return;
  }
  const parsed: unknown[] = [];
  for (const s of raw) {
    try { parsed.push(JSON.parse(s)); } catch { /* corrupt entry: nothing named, nothing to clean up */ }
  }
  const restores = parsed.map(entryToRestore).filter((r): r is RestoreEntry => r !== null);
  // Reserved for every name before any of the following awaits: a paste
  // racing the restore must never take a name a restored block will claim.
  reserveNames(restores.map((r) => r.name));
  const kept: string[] = [];
  for (const r of restores) {
    const transientReason = await restoreOne(r, deps);
    if (transientReason) kept.push(`${r.name}: ${transientReason}`);
  }
  if (kept.length) note(`Kept on Disk, Not Restored: ${kept.join("; ")}`);
}

/** One entry → one block, a deleted entry if it can't ever come back, or a
 *  kept-but-unrestored entry (its reason returned) if the failure describes
 *  the world right now rather than the block's own bytes (a read error
 *  or an admission refusal may pass on a later boot). */
async function restoreOne(r: RestoreEntry, deps: TrayRestoreDeps): Promise<string | null> {
  const { blocks, addDroppedFile, addImageBlock, addTextBlock } = deps;
  const restore: Restore = { name: r.name, at: r.at, ...(r.collapsed ? { collapsed: true } : {}), ...(r.annotation ? { annotation: r.annotation } : {}) };
  let outcome: Outcome;
  try {
    if (r.mode === "file") {
      outcome = await addDroppedFile(r.path!, restore);
    } else if (r.mode === "png") {
      const buf = await invoke("read_workbench_png", { name: r.name });
      outcome = await addImageBlock(new Blob([buf], { type: "image/png" }), r.source, undefined, restore);
    } else {
      outcome = addTextBlock(r.text ?? "", r.source, restore);
      if (outcome.ok && r.truncated) {
        const b = blocks.find((x) => x.name === r.name);
        if (b) b.note.textContent = "truncated on restore";
      }
    }
  } catch (e) {
    // Only `read_workbench_png` can throw here (addDroppedFile catches its
    // own read failures; addTextBlock/addImageBlock never throw) — a read
    // error, not a corrupt block.
    outcome = { ok: false, reason: String(e), transient: true };
  }
  releaseName(r.name);
  if (outcome.ok) return null;
  if (outcome.transient) return outcome.reason; // kept on disk, tried again next boot
  void invoke("delete_workbench_entry", { name: r.name }).catch(() => {});
  return null;
}
