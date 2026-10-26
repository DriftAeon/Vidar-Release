// A tab-local explanation of how each rune reached this session. Derived from the
// catalog and the existing load/read trace; no separate transcript reader.
import { readKeys, readSet, wasRead } from "./bare/on-demand-loads";
import { normPath, type TracedLibrary } from "./trace";
import type { RunesLoaded } from "./types";

export interface LoadReason { reason: "always" | "path" | "recall"; trigger?: string }

/** Loaded set targets take precedence; an explicit read explains an otherwise unloaded rune. */
export function runeLedger(t: TracedLibrary, loaded: RunesLoaded | null): Map<string, LoadReason> {
  const out = new Map<string, LoadReason>();
  if (!loaded || loaded.source === "none") return out;
  const files = new Map(loaded.files.map((f) => [normPath(f.path), f]));
  for (const s of t.sets) {
    if (!s.set.targetAbs) continue;
    const file = files.get(normPath(s.set.targetAbs));
    if (!file) continue;
    for (const m of s.set.members) {
      const prior = out.get(m.id);
      if (file.when === "start") out.set(m.id, { reason: "always" });
      else if (!prior) out.set(m.id, { reason: "path", ...(file.trigger ? { trigger: file.trigger } : {}) });
    }
  }
  const reads = readSet(readKeys(loaded));
  for (const r of t.lib.runes) {
    if (!out.has(r.id) && wasRead(reads, r)) out.set(r.id, { reason: "recall" });
  }
  return out;
}

export function loadedLine(load: LoadReason): string {
  if (load.reason === "always") return "Loaded: Always";
  if (load.reason === "recall") return "Loaded: Recall";
  return load.trigger ? `Loaded: Path (${load.trigger})` : "Loaded: Path";
}
