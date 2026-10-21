// Payloads of `runes_catalog` (src-tauri/src/rules/catalog.rs) and `runes_loaded` (rules/loaded.rs), camelCase.
// Every path is plain (no `\\?\` prefix). Content of a transcript is never part of `RunesLoaded`.

export type RuneLibraryKey = "global" | "vidar";
export type RuneState = "draft" | "active" | "disabled";

export interface RuneSetMember {
  id: string;
  /** Came from the `<?recall?>` marker rather than a slot line. */
  recall: boolean;
}

export interface RuneSet {
  id: string;
  /** Path under the library's parent from targets.json, e.g. `CLAUDE.md`. */
  target: string | null;
  targetAbs: string | null;
  activate: string;
  paths: string[];
  scope: string[];
  /** 1 every session, 2 path-scoped (`.claude/` target), 3 recall pointers, 4 not loaded, 5 via plugin hook (`plugins/` target, untraced). */
  tier: 1 | 2 | 3 | 4 | 5;
  members: RuneSetMember[];
}

export interface RuneItem {
  id: string;
  kind: "rule" | "fact" | "procedure";
  scope: string[];
  state: RuneState;
  activate: string;
  description: string;
  path: string;
  body: string;
}

export interface RuneLibrary {
  key: RuneLibraryKey;
  root: string;
  present: boolean;
  error?: string;
  sets: RuneSet[];
  runes: RuneItem[];
}

export interface RunesCatalog {
  /** Global first, then Vidar. */
  libraries: RuneLibrary[];
}

export interface RunesLoadedFile {
  path: string;
  memoryType: string;
  /** `start`: instructions at session start; `touch`: nested memory loaded on a file touch. */
  when: "start" | "touch";
}

export type RunesLoaded =
  | { source: "transcript"; files: RunesLoadedFile[]; truncated: boolean }
  | { source: "none"; reason: string; files: RunesLoadedFile[]; truncated: boolean };
