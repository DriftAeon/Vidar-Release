// Live approval registry: every pending approval record, from two kinds of producer. Snapshot producers
// (Flow, Rendered, subagent) replace their own slice and keep first-answer-wins in their own state.
// Imperative producers (ctl-*, astra, review-dispatch) call `openApproval`, which owns one flight per
// record: a single timer to `expiresAtMs`, and `finish()` runs once whichever of answer, expiry or
// `cancelApproval` gets there first. A later answer throws `Already Answered`. No DOM, no invoke, no persistence.

import type { ApprovalAnswer, ApprovalOutcome, ApprovalRecord } from "./approval";

export interface ApprovalEntry {
  record: ApprovalRecord;
  answer(a: ApprovalAnswer): Promise<void>;
}

interface Flight {
  entry: ApprovalEntry;
  timer: ReturnType<typeof setTimeout> | null;
  onSettle: (outcome: ApprovalOutcome) => void;
}

const slices = new Map<string, readonly ApprovalEntry[]>();
const flights = new Map<string, Flight>();
const listeners = new Set<(entries: readonly ApprovalEntry[]) => void>();
let merged: readonly ApprovalEntry[] = [];

function refresh(): void {
  const all = [...slices.values()].flat();
  for (const f of flights.values()) all.push(f.entry);
  merged = all.sort((a, b) => b.record.askedAtMs - a.record.askedAtMs);
  for (const fn of [...listeners]) {
    try { fn(merged); } catch (e) { console.error("approvals subscriber threw", e); }
  }
}

/** The refusal text the retired modal gave a second ask of the same kind, so a caller's err line is unchanged. */
export function approvalBusy(origin: string): string {
  return `an ask for "${origin}" is already on screen or queued; only one at a time is useful`;
}

export function setApprovalSlice(source: string, entries: ApprovalEntry[]): void {
  if (entries.length === 0) slices.delete(source);
  else slices.set(source, [...entries]);
  refresh();
}

export function liveApprovals(): readonly ApprovalEntry[] {
  return merged;
}

export function subscribeApprovals(fn: (entries: readonly ApprovalEntry[]) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function finish(id: string, outcome: ApprovalOutcome): boolean {
  const f = flights.get(id);
  if (!f) return false;
  if (f.timer) clearTimeout(f.timer);
  flights.delete(id);
  try { refresh(); } finally { f.onSettle(outcome); }
  return true;
}

function askerKey(r: ApprovalRecord): string {
  return r.asker.tab ? `t:${r.asker.tab}` : `l:${r.asker.label}`;
}

function sameAsker(a: ApprovalRecord, b: ApprovalRecord): boolean {
  return askerKey(a) === askerKey(b);
}

const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Opens an imperative approval; `onSettle` runs once. Returns the refusal reason (no record made) or null.
 * Bounds: `astra` one live record globally; every other origin one per (origin, asker).
 */
export function openApproval(record: ApprovalRecord & { expiresAtMs: number }, onSettle: (outcome: ApprovalOutcome) => void): string | null {
  const dup = record.id;
  if (flights.has(dup) || [...slices.values()].some((s) => s.some((e) => e.record.id === dup))) {
    return `an approval with id "${dup}" is already open`;
  }
  for (const f of flights.values()) {
    const r = f.entry.record;
    if (r.origin !== record.origin) continue;
    if (record.origin === "astra" || sameAsker(r, record)) return approvalBusy(record.origin);
  }
  const id = record.id;
  const entry: ApprovalEntry = {
    record,
    async answer(a) {
      if (!finish(id, a)) throw new Error("Already Answered");
    },
  };
  const delay = Math.min(MAX_TIMER_MS, Math.max(0, record.expiresAtMs - Date.now()));
  const timer = setTimeout(() => { finish(id, { verdict: "expired", reason: "expired" }); }, Number.isNaN(delay) ? 0 : delay);
  flights.set(id, { entry, timer, onSettle });
  refresh();
  return null;
}

/** Settles an open approval as cancelled; false when it already settled. */
export function cancelApproval(id: string, reason: string): boolean {
  return finish(id, { verdict: "cancelled", reason });
}
