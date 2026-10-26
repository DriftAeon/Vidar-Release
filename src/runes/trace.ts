// Runes trace (pure, no DOM): which sets and runes a tab loaded, from the catalog and the tab's
// loaded files. Path match is case-insensitive, backslash-normalised equality of a set's `targetAbs`
// with a loaded path; transcript paths are only compared, never opened.
import type { RuneLibrary, RuneSet, RunesCatalog, RunesLoaded } from "./types";

/** null = unknown (no transcript to trace against). */
export type SetState = "Loaded" | "On Touch" | "Not Loaded" | "Via Plugin Hook" | null;

export interface TracedSet {
  set: RuneSet;
  state: SetState;
}

export interface TracedLibrary {
  lib: RuneLibrary;
  /** Tier order: CLAUDE.md then AGENTS.md within tier 1, then id. */
  sets: TracedSet[];
  /** rune id → loaded (any holding set Loaded); null when the trace is unknown. */
  runeLoaded: Map<string, boolean | null>;
  /** rune id → ids of the sets holding it, in set order. */
  setsOf: Map<string, string[]>;
}

export interface OutsideFile {
  path: string;
  /** The path relative to the repo root when under it, else the path as loaded. */
  label: string;
}

export interface RunesTrace {
  /** True when a transcript was read; set states are null otherwise (plugin sets excepted). */
  known: boolean;
  libraries: TracedLibrary[];
  /** Loaded files no set targets: listed under "Not from a Rune Library". */
  outside: OutsideFile[];
}

export const normPath = (p: string): string => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

const T1_ORDER = ["claude.md", "agents.md"];
const baseName = (p: string | null): string => (p ?? "").split(/[\\/]/).pop()!.toLowerCase();
const t1Rank = (s: RuneSet): number => {
  const i = T1_ORDER.indexOf(baseName(s.target));
  return i < 0 ? T1_ORDER.length : i;
};

export function sortSets(sets: RuneSet[]): RuneSet[] {
  return [...sets].sort((a, b) => a.tier - b.tier || (a.tier === 1 ? t1Rank(a) - t1Rank(b) : 0) || a.id.localeCompare(b.id));
}

/** Tier 5 (catalog.rs) or a `plugins/` target: loaded by a plugin hook, never traced. */
export const isPluginTarget = (s: RuneSet): boolean => (s.tier as number) === 5 || (!!s.target && /^plugins[\\/]/i.test(s.target));

/** False for a traced set this session can no longer load: an every-session file it did not read at
 *  start (another agent's AGENTS.md or CLAUDE.md) or a tier 4 set. Path-scoped and recall sets can
 *  still load later; an untraced set (state null) is unknown, so it is kept. */
export const canLoad = (t: TracedSet): boolean => !(t.state === "Not Loaded" && (t.set.tier === 1 || t.set.tier === 4));

export function traceRunes(catalog: RunesCatalog, loaded: RunesLoaded | null, repoRoot: string | null): RunesTrace {
  const known = !!loaded && loaded.source !== "none";
  const files = known ? loaded!.files : [];
  const byPath = new Map<string, "start" | "touch">();
  for (const f of files) if (!byPath.has(normPath(f.path))) byPath.set(normPath(f.path), f.when);
  const targeted = new Set<string>();

  const stateOf = (s: RuneSet): SetState => {
    if (isPluginTarget(s)) return "Via Plugin Hook";
    if (!known) return null;
    if (s.targetAbs && byPath.has(normPath(s.targetAbs))) return "Loaded";
    return s.tier === 2 ? "On Touch" : "Not Loaded";
  };

  const libraries = catalog.libraries.map((lib): TracedLibrary => {
    const sets = sortSets(lib.sets).map((set) => {
      if (set.targetAbs) targeted.add(normPath(set.targetAbs));
      return { set, state: stateOf(set) };
    });
    const setsOf = new Map<string, string[]>();
    const runeLoaded = new Map<string, boolean | null>();
    for (const r of lib.runes) runeLoaded.set(r.id, known ? false : null);
    for (const t of sets) {
      for (const m of t.set.members) {
        const held = setsOf.get(m.id) ?? [];
        if (!held.includes(t.set.id)) held.push(t.set.id);
        setsOf.set(m.id, held);
        if (known && t.state === "Loaded") runeLoaded.set(m.id, true);
      }
    }
    return { lib, sets, runeLoaded, setsOf };
  });

  const root = repoRoot ? `${normPath(repoRoot)}\\` : null;
  const outside: OutsideFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const n = normPath(f.path);
    if (targeted.has(n) || seen.has(n)) continue;
    seen.add(n);
    const label = root && n.startsWith(root) ? f.path.slice(root.length).replace(/\\/g, "/") : f.path;
    outside.push({ path: f.path, label });
  }
  return { known, libraries, outside };
}
