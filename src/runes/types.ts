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
  origin?: string;
  closesWhen?: string;
  why?: string;
  example?: string;
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

/** The runeLoadHistory file (`runes_load_history` reply). Dates are `YYYY-MM-DD`. */
export interface LoadHistoryTranscript { len: number; mtime: number; head: string; partial: boolean }
export interface LoadHistory {
  version: 1;
  since: string;
  lastSweep: string;
  transcripts: Record<string, LoadHistoryTranscript>;
  paths: Record<string, string>;
  reads: Record<string, string>;
  runeReads: Record<string, string>;
  skills: Record<string, string>;
  /** `<library>/<set>`. */
  bareSets: Record<string, string>;
}

export interface RunesLoadedFile {
  path: string;
  memoryType: string;
  /** `start`: instructions at session start; `touch`: nested memory loaded on a file touch. */
  when: "start" | "touch";
  /** File named by the preceding unambiguous assistant file-tool message, when known. */
  trigger?: string;
  /** Codex rows only: where the row came from. Absent on Claude rows. */
  source?: "vault" | "rollout";
}

export type RunesLoaded =
  | { source: "transcript" | "vault" | "rollout"; files: RunesLoadedFile[]; reads?: string[]; runeReads?: string[]; skills?: string[]; truncated: boolean }
  | { source: "none"; reason: string; files: RunesLoadedFile[]; reads?: string[]; runeReads?: string[]; skills?: string[]; truncated: boolean };
