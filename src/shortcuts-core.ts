// Pure chord parsing, normalization, conflict rejection and the post-save rollback
// decision. No DOM, no module state: everything comes in as a parameter, so this file
// is testable without wiring the registry or the modal.

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

// Owned by the terminal (sessions.ts key handler) or by plain editing in the
// workbench tray (paste). Binding one would silently break the other surface.
export const RESERVED = new Set([
  "Ctrl+F", "Ctrl+=", "Ctrl++", "Ctrl+-", "Ctrl+0",
  "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+Z",
]);

// Canonical chord string: modifiers in fixed order, then the key. Display and
// matching share this one form, so "Ctrl+Shift+T" never mismatches "Shift+Ctrl+T".
export function chordOf(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  const k = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(k);
  return parts.join("+");
}

/** The shortcut a pressed chord fires, or undefined. `current` maps id → bound chord
 *  (override or defaultKeys); `external` rows (voice hotkey) are matched elsewhere. */
export function matchShortcut<T extends { id: string; external?: unknown }>(
  chord: string,
  registry: readonly T[],
  current: Map<string, string>,
): T | undefined {
  return registry.find((s) => !s.external && current.get(s.id) === chord);
}

/** A binding a candidate chord is checked against for conflicts. */
export interface ChordBinding {
  id: string;
  name: string;
}

// Why a chord can't be bound, or null when it can. `current` and `bindings` are passed in
// rather than read from a shared registry, so a caller can check a chord against any table.
export function rejection(
  chord: string,
  forId: string,
  current: Map<string, string>,
  bindings: ChordBinding[],
): string | null {
  const m = chord.match(/^((?:(?:Ctrl|Alt|Shift|Meta)\+)*)(.+)$/);
  if (!m) return "unrecognised key";
  const mods = m[1];
  const key = m[2];
  if (!/(?:Ctrl|Alt|Meta)\+/.test(mods) && !/^F\d{1,2}$/.test(key)) {
    return "needs Ctrl, Alt or an F-key";
  }
  if (RESERVED.has(chord)) return "used by the terminal";
  for (const b of bindings) {
    if (b.id !== forId && current.get(b.id) === chord) return `already bound to ${b.name}`;
  }
  return null;
}

// After a save attempt: the chord that should actually be kept. A failed save
// (`saveErr` non-null) keeps the previous bind rather than the unsaved chord — the
// rollback rule. A caller applies this to its own current-value map.
export function resolveAfterSave(prev: string, attempted: string, saveErr: string | null): string {
  return saveErr ? prev : attempted;
}
