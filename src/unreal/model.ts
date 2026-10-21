// Unreal bench tab model: the `unreal_status` result as groups, the Send target and the Send text.
import type { UnrealDiag, UnrealStatus } from "../ipc";

export const SEND_MAX_BYTES = 1024;

/** The D4 keys, per object, so a fixture or a Rust change that drifts from the model fails a test. */
export const UNREAL_KEYS = {
  status: ["project", "editor", "build", "liveCoding", "diags"],
  project: ["name", "root", "uproject"],
  result: ["result", "at"],
  diag: ["file", "line", "severity", "text", "source"],
} as const;

export interface UnrealGroups { errors: UnrealDiag[]; warnings: UnrealDiag[] }

export function groupDiags(status: Pick<UnrealStatus, "diags">): UnrealGroups {
  const errors: UnrealDiag[] = [];
  const warnings: UnrealDiag[] = [];
  for (const d of status.diags) (d.severity === "error" ? errors : warnings).push(d);
  return { errors, warnings };
}

/** Dismissed diagnostics of one project, with the build and live-coding times they were dismissed under. */
export interface DismissedEntry { build: number | null; live: number | null; keys: string[] }
export const MAX_DISMISSED_KEYS = 500;
export const MAX_DISMISSED_PROJECTS = 20;

export function diagKey(d: Pick<UnrealDiag, "severity" | "file" | "line" | "text">): string {
  return `${d.severity}|${d.file ?? ""}|${d.line ?? ""}|${d.text}`;
}

/** The entry to use for this status: an entry stored under other build/live-coding times is cleared. */
export function currentDismissed(
  stored: DismissedEntry | undefined,
  status: { build: { at: number | null } | null; liveCoding: { at: number | null } | null },
): DismissedEntry {
  const build = status.build?.at ?? null;
  const live = status.liveCoding?.at ?? null;
  if (stored && stored.build === build && stored.live === live) return stored;
  return { build, live, keys: [] };
}

export function dismissDiag(entry: DismissedEntry, diag: Parameters<typeof diagKey>[0]): DismissedEntry {
  const key = diagKey(diag);
  if (entry.keys.includes(key)) return entry;
  return { ...entry, keys: [...entry.keys, key].slice(-MAX_DISMISSED_KEYS) };
}

/** Adds every diagnostic's key in one step, within the same bound as dismissDiag. */
export function dismissDiags(entry: DismissedEntry, diags: Parameters<typeof diagKey>[0][]): DismissedEntry {
  const fresh = [...new Set(diags.map(diagKey))].filter((k) => !entry.keys.includes(k));
  if (!fresh.length) return entry;
  return { ...entry, keys: [...entry.keys, ...fresh].slice(-MAX_DISMISSED_KEYS) };
}

export function withoutDismissed<T extends Pick<UnrealStatus, "diags">>(status: T, entry: DismissedEntry): T {
  if (!entry.keys.length) return status;
  const hidden = new Set(entry.keys);
  return { ...status, diags: status.diags.filter((d) => !hidden.has(diagKey(d))) };
}

/** The whole map with one project's entry set (empty entry removes it); oldest projects drop past the bound. */
export function storeDismissed(
  map: Record<string, DismissedEntry> | undefined,
  root: string,
  entry: DismissedEntry,
): Record<string, DismissedEntry> {
  const next: Record<string, DismissedEntry> = {};
  for (const [k, v] of Object.entries(map ?? {})) if (k !== root) next[k] = v;
  if (entry.keys.length) next[root] = entry;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DISMISSED_PROJECTS))) delete next[k];
  return next;
}

/** The tab that last edited the diagnostic's file while still open, else the focused tab, else null. */
export function sendTarget(
  diag: Pick<UnrealDiag, "file">,
  lastToucher: (path: string) => { sessionId: string } | null,
  isLive: (sessionId: string) => boolean,
  focusedId: string | null,
): string | null {
  const t = diag.file ? lastToucher(diag.file) : null;
  if (t && isLive(t.sessionId)) return t.sessionId;
  return focusedId;
}

// C0 and C1 controls, line/paragraph separators, bidi embeddings/overrides/isolates
const STRIP = new RegExp("[\\p{Cc}\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069]", "gu");

function capBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

/** `Unreal error at <file>(<line>): <text>`; never ends in `\r` (that would submit it). */
export function sendText(diag: Pick<UnrealDiag, "file" | "line" | "text">): string {
  const clean = (s: string) => s.replace(STRIP, " ").replace(/ {2,}/g, " ").trim();
  const where = diag.file ? `${clean(diag.file)}${diag.line != null ? `(${diag.line})` : ""}` : "the log";
  return capBytes(`Unreal error at ${where}: ${clean(diag.text)}`, SEND_MAX_BYTES).trimEnd();
}
