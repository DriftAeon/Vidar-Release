// The runtime character catalogue: `list_characters` loaded at
// start and again after every mutating command, with a revision counter the character panel
// keys its reload on. Style notes ("No Cel Textures, Showing Standard") are what the renderer
// found at load time; they live here for the Settings row and do not bump the revision.
import { invoke } from "../ipc";
import type { CharacterList, CharacterPack } from "./catalog";

let list: CharacterList | null = null;
let revision = 0;
let loading: Promise<CharacterList> | null = null;
const listeners = new Set<() => void>();
const notes = new Map<string, string>();
const noteListeners = new Set<() => void>();

export function characterList(): CharacterList | null {
  return list;
}

export function characterRevision(): number {
  return revision;
}

/** Called after every load; returns the unsubscribe. */
export function onCharactersChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-reads the packs from Rust; the revision bumps (and listeners run) only when the list
 *  differs, so a refresh that finds nothing new does not re-materialize the stage. `rehash`
 *  (Settings › Characters opening) makes Rust rehash every model instead of trusting its
 *  len+mtime cache. A failed read keeps the last list. */
export function refreshCharacters(rehash = false): Promise<CharacterList> {
  const request = invoke("list_characters", { refresh: rehash }).then((next) => {
    if (list && JSON.stringify(list) === JSON.stringify(next)) return list;
    list = next;
    revision += 1;
    listeners.forEach((fn) => fn());
    return next;
  });
  loading = request;
  void request.catch(() => {}).finally(() => { if (loading === request) loading = null; });
  return request;
}

/** The list, loading it once if nothing has been read yet. */
export function ensureCharacters(): Promise<CharacterList> {
  if (list) return Promise.resolve(list);
  return loading ?? refreshCharacters();
}

async function mutate<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    await refreshCharacters().catch(() => {});
  }
}

/** Opens the `.glb` picker in Rust; the new pack's id, or null when cancelled. */
export const addCharacter = () => mutate(() => invoke("add_character"));
// repin/update/remove take the entry's `target` (a valid pack's id, else `folder:<name>`),
// never its id, so a command on an invalid row only touches that row's folder.
/** pick = false re-hashes the current file (Pin New File); true opens the picker (Browse). */
export const repinCharacter = (target: string, pick: boolean) => mutate(() => invoke("repin_character", { target, pick }));
export type CharacterPatch = Partial<Pick<CharacterPack, "name" | "material" | "answersTo" | "lighting" | "playrate">>;
export const updateCharacter = (target: string, patch: CharacterPatch) => mutate(() => invoke("update_character", { target, patch }));
export const removeCharacter = (target: string) => mutate(() => invoke("remove_character", { target }));
export const setDefaultCharacter = (id: string | null) => mutate(() => invoke("set_default_character", { id }));

export function styleNote(id: string): string | null {
  return notes.get(id) ?? null;
}

export function setStyleNote(id: string, note: string | null): void {
  if ((notes.get(id) ?? null) === note) return;
  if (note) notes.set(id, note); else notes.delete(id);
  noteListeners.forEach((fn) => fn());
}

export function onStyleNotes(fn: () => void): () => void {
  noteListeners.add(fn);
  return () => noteListeners.delete(fn);
}
