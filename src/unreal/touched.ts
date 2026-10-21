// Files the agents in this window edited: folded path -> the last tab session that touched it.
// Fed only from live (non-replay) Edit/Write/MultiEdit/NotebookEdit tool starts; in memory only.

export interface Touch { sessionId: string; at: number }

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const touched = new Map<string, Touch>();

/** Case-folded, `/` to `\`: the key both a tool input and a diagnostic path reduce to. */
export function foldPath(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

/** A tool start from tab `sessionId`; anything but the four edit tools, or without a path, is ignored. */
export function noteToolStart(sessionId: string, name: string, input: unknown, at = Date.now()): void {
  if (!EDIT_TOOLS.has(name) || !input || typeof input !== "object") return;
  const o = input as Record<string, unknown>;
  const p = typeof o.file_path === "string" ? o.file_path : typeof o.notebook_path === "string" ? o.notebook_path : null;
  if (p) touched.set(foldPath(p), { sessionId, at });
}

export function lastToucher(path: string): Touch | null {
  return touched.get(foldPath(path)) ?? null;
}

export function clearTouched(): void {
  touched.clear();
}
