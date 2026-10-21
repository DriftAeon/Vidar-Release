// The shortcut/setting-row table and the open category list. Categories used to
// be a closed `"keybinds" | "audio"` union in shortcuts.ts; a caller now registers one by
// calling `registerCategory` once, so a new destination (General, etc.) doesn't require
// widening a union here.

import { invoke } from "../ipc";
import { rejection as coreRejection, resolveAfterSave, type ChordBinding } from "../shortcuts-core";

// `description` is the dim line under the name: only a consequence the name doesn't state (needs a
// restart, a limit); `tip` is the row's tooltip for an explanation (docs/runs/2026-10-01-descriptor-text/plan.md).
export interface Shortcut {
  id: string;
  name: string;
  description?: string;
  tip?: string;
  defaultKeys: string;
  run: () => void;
  category?: string; // undefined = "keybinds"
  // Owned elsewhere (voice hotkey): not matched by the in-app listener, not written to
  // `shortcuts`. `initial` is its stored value; `external` persists a new chord and
  // returns an error string (the row keeps its previous bind) or null.
  initial?: string;
  external?: (chord: string) => Promise<string | null>;
}

/// A non-chord control shown under the shortcut rows (selects, etc.). `control` is
/// called on every open so the owner can refresh its options; `setError` writes the
/// row's error line ("" clears it). `restartRequired` rows say so under the description.
export interface SettingRow {
  name: string;
  description?: string;
  tip?: string;
  category: string;
  restartRequired?: boolean;
  /** The control takes the row's full width under the name (list editors like Workspaces). */
  wide?: boolean;
  /** Extra text the settings search matches besides name and description. */
  keywords?: () => string;
  control: (setError: (msg: string) => void) => HTMLElement;
}

const DEFAULT_CATEGORY = "keybinds";

const registry: Shortcut[] = [];
const settingRows: SettingRow[] = [];
const current = new Map<string, string>();

// Registered categories, insertion order. "all" is implicit and not stored here; the two
// built-ins are registered below so behaviour matches the old closed union until another
// destination lands.
export type CategoryEntry = [string, string, "module"?];
const categories: CategoryEntry[] = [];
const categoryIds = new Set<string>();

/** `before` places the page ahead of an already-registered one in the rail (General and
 *  Workspaces sit above Keybinds); omitted or unknown = appended. */
export function registerCategory(id: string, label: string, before?: string, group?: "module") {
  if (categoryIds.has(id)) return;
  categoryIds.add(id);
  const at = before ? categories.findIndex(([c]) => c === before) : -1;
  if (at < 0) categories.push([id, label, group]);
  else categories.splice(at, 0, [id, label, group]);
}

export function categoryList(): CategoryEntry[] {
  return categories.slice();
}

/** Rail order: core A-Z, then the module group (Modules first, the rest A-Z). Pure. */
export function orderCategories(list: CategoryEntry[]): CategoryEntry[] {
  const az = (a: CategoryEntry, b: CategoryEntry) => a[1].localeCompare(b[1]);
  const core = list.filter((c) => c[2] !== "module").sort(az);
  const mods = list.filter((c) => c[2] === "module");
  const head = mods.filter((c) => c[0] === "modules");
  const rest = mods.filter((c) => c[0] !== "modules").sort(az);
  return [...core, ...head, ...rest];
}

registerCategory(DEFAULT_CATEGORY, "Keybinds");
registerCategory("audio", "Audio", undefined, "module");

export function getRegistry(): Shortcut[] {
  return registry;
}

export function getSettingRows(): SettingRow[] {
  return settingRows;
}

export function getCurrent(): Map<string, string> {
  return current;
}

export function categoryOf(s: Shortcut): string {
  return s.category ?? DEFAULT_CATEGORY;
}

export function initRegistry(defs: Shortcut[], overrides: Record<string, string>) {
  for (const s of defs) {
    registry.push(s);
    current.set(s.id, overrides[s.id] || s.defaultKeys);
  }
}

/** Late registration for modules that init after the shortcut table (voice). Returns a remover
 *  for a capability's dispose. */
export function addShortcut(s: Shortcut): () => void {
  registry.push(s);
  current.set(s.id, s.initial || s.defaultKeys);
  return () => {
    const i = registry.indexOf(s);
    if (i < 0) return;
    registry.splice(i, 1);
    if (!registry.some((o) => o.id === s.id)) current.delete(s.id);
  };
}

/** Returns a remover, like addShortcut. */
export function addSettingRow(r: SettingRow): () => void {
  settingRows.push(r);
  return () => {
    const i = settingRows.indexOf(r);
    if (i >= 0) settingRows.splice(i, 1);
  };
}

// Why a chord can't be bound, or null when it can — the registry's live table applied to
// the pure core check.
export function rejection(chord: string, forId: string): string | null {
  const bindings: ChordBinding[] = registry.map((s) => ({ id: s.id, name: s.name }));
  return coreRejection(chord, forId, current, bindings);
}

async function persist(): Promise<string | null> {
  const overrides: Record<string, string> = {};
  for (const s of registry) {
    if (s.external) continue;
    const c = current.get(s.id);
    if (c && c !== s.defaultKeys) overrides[s.id] = c;
  }
  try {
    await invoke("save_shortcuts", { shortcuts: overrides });
    return null;
  } catch (e) {
    return String(e);
  }
}

// Sets `s`'s current chord to `attempted`, saves it (or runs its `external` persister),
// and rolls back to `prev` on a save error. Returns the save error, if any.
export async function commitChord(s: Shortcut, attempted: string): Promise<string | null> {
  const prev = current.get(s.id) ?? s.defaultKeys;
  current.set(s.id, attempted);
  const saveErr = s.external ? await s.external(attempted) : await persist();
  current.set(s.id, resolveAfterSave(prev, attempted, saveErr));
  return saveErr;
}
