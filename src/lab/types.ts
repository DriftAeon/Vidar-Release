// Payload of `lab_item` (src-tauri/src/lab.rs), camelCase. A history row mirrors
// tests/fixtures/lab/history-row.json, which the Node runner writes.

export interface LabCase {
  name: string;
  graders: number;
  tools: string[];
  /** case.json declares a tool list; otherwise the list above is the Read default. */
  toolsDeclared: boolean;
  permissionMode: string;
  timeoutSec: number;
  hasPrompt: boolean;
  /** Set when the case folder is unusable; the case is listed, not hidden. */
  error?: string;
}

export interface LabArms<T> {
  with: T;
  without: T;
}

export interface LabPerCase {
  case: string;
  with: number | null;
  without: number | null;
  delta: number | null;
  runs: LabArms<number[]>;
}

export interface LabRun {
  runId: string;
  itemKind: string;
  item: string;
  lib: string;
  /** Instruction file the run measured; only Codex rows carry it (absent means CLAUDE.md). */
  target?: string | null;
  libCommit: string | null;
  itemCommit: string | null;
  armHash: LabArms<string>;
  cases: number;
  repeats: number;
  sessions: number;
  costUsd: LabArms<number | null>;
  scores: LabArms<number | null> & { delta: number | null };
  perCase: LabPerCase[];
  partial: boolean;
  dry: boolean;
  isolation: string;
  comparable: boolean;
  startedAt: string;
}

export interface LabItem {
  cases: LabCase[];
  runs: LabRun[];
  /** `tools/lab/run.mjs` exists; the tab offers the copy-command buttons only then. */
  runnerPresent: boolean;
  /** Set when the suite folder could not be read (other than missing). */
  suiteError?: string;
  /** Set when `history.jsonl` could not be read (other than missing). */
  historyError?: string;
  /** History lines that were not valid rows. */
  skippedLines: number;
}
