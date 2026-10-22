// Workbench block actions: Copy, Copy Path, and the one-time save to
// bridge\clips that a path action on a content block needs. Moved verbatim from workbench.ts;
// each action re-checks the block's `gen` after every await so a removal makes it bail.

import { invoke } from "../ipc";
import { publishBlock } from "./workbench-bridge";
import type { BlockLike } from "./workbench-restore";

/** The subset of workbench.ts's `Block` the actions read and write. */
type ActionBlock = BlockLike & {
  gen: number;
  blob?: Blob;
  saving?: Promise<string>;
  note: HTMLElement;
};

/* ---- actions ---- */

export async function copyContent(b: ActionBlock) {
  const gen = b.gen;
  try {
    // file blocks copy their content too (text, or the image); Copy Path is the path action
    if (b.kind === "text") await navigator.clipboard.writeText(b.text ?? "");
    else if (b.blob) await navigator.clipboard.write([new ClipboardItem({ "image/png": b.blob })]);
    if (b.gen === gen) b.note.textContent = ""; // success is silent (2026-10-03); only failures show
  } catch (e) {
    if (b.gen === gen) b.note.textContent = `Copy Failed: ${e}`;
  }
}

/** Saves once if needed (shared promise; file blocks already have a path and
 *  never save), then copies the path. Insert Path was removed (2026-10-03:
 *  a path usually gets sculpted into a prompt by hand). */
export async function copyPathAction(b: ActionBlock) {
  const gen = b.gen;
  if (!b.path) b.note.textContent = "saving…";
  let path: string;
  try {
    path = await save(b);
  } catch (e) {
    if (b.gen === gen) b.note.textContent = `save failed: ${e}`;
    return;
  }
  if (b.gen !== gen) return; // removed meanwhile: file may exist, nothing else happens
  b.path = path;
  publishBlock(b); // it has bytes on disk now; the entry should say so
  try {
    await navigator.clipboard.writeText(path);
    if (b.gen === gen) b.note.textContent = ""; // clears "saving…"; success is silent
  } catch (e) {
    if (b.gen === gen) b.note.textContent = `Copy Failed: ${e}`;
  }
}

/** The save half of Copy Path, for Open in Browser: the block's path, saved once if it has none. */
export async function ensureSaved(b: ActionBlock): Promise<string | undefined> {
  const gen = b.gen;
  const path = await save(b);
  if (b.gen !== gen) return undefined; // removed meanwhile
  if (!b.path) {
    b.path = path;
    publishBlock(b);
  }
  return path;
}

function save(b: ActionBlock): Promise<string> {
  if (b.path) return Promise.resolve(b.path);
  if (!b.saving) {
    b.saving = (async () => {
      if (b.kind === "text") return invoke("save_clip", { content: b.text ?? "" });
      const buf = await b.blob!.arrayBuffer();
      return invoke("save_clip_image", buf);
    })().finally(() => (b.saving = undefined));
  }
  return b.saving;
}
