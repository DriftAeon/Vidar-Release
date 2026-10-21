// Run-history leaf: envelope load/save against a StorageLike, cap-50 eviction, and the
// interrupted-run reconcile. Leaf module — only `import type` crosses out (node --test rule), so
// this file takes storage as a parameter and never touches window/browser storage/S/the DOM.

import type { FlowRun, FlowRunNodeState, FlowRunStatus } from "./run";

// A Map-backed stub in tests, the Flow file store (file-storage.ts) from runs-store.ts in the app. One definition in
// prefs-core.ts; `import type` is erased, so this leaf still loads standalone.
import type { StorageLike } from "../prefs-core";
export type { StorageLike };

// Restated verbatim ("vidar.flow.runs.v1 holds { v: 1, runs }" and
// "the cap-50 eviction") — not imported from store-core.ts, same leaf-compiles-standalone reason.
export const RUNS_KEY = "vidar.flow.runs.v1";
export const RUNS_CAP = 50;

export interface RunsEnvelope {
  v: 1;
  runs: FlowRun[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseRunsEnvelope(parsed: unknown): RunsEnvelope | null {
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.runs)) return null;
  return { v: 1, runs: parsed.runs as FlowRun[] };
}

/** Tri-state read result, same shape as store-core.ts's `EnvelopeRead<T>` — kept apart so a
 *  caller about to seed/overwrite the key can back up `raw` first (store-core.ts's rationale,
 *  applied here for the same reason: a truncated write or a downgraded version must not silently
 *  wipe stored runs on the next mount). */
export type EnvelopeRead =
  | { status: "absent"; raw: null; env: null }
  | { status: "invalid"; raw: string; env: null }
  | { status: "ok"; raw: string; env: RunsEnvelope };

export function readRunsEnvelope(storage: StorageLike): EnvelopeRead {
  let raw: string | null;
  try {
    raw = storage.getItem(RUNS_KEY);
  } catch {
    return { status: "absent", raw: null, env: null };
  }
  if (!raw) return { status: "absent", raw: null, env: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    const env = parseRunsEnvelope(parsed);
    if (env === null) return { status: "invalid", raw, env: null };
    return { status: "ok", raw, env };
  } catch {
    return { status: "invalid", raw, env: null };
  }
}

/** Absent, invalid, and a `v` mismatch all collapse to `null` — same "no v1 migration defined for
 *  a version mismatch" treatment as store-core.ts's `loadGraphsEnvelope`. Use `readRunsEnvelope`
 *  instead when "absent" and "invalid" need telling apart. */
export function loadRunsEnvelope(storage: StorageLike): RunsEnvelope | null {
  return readRunsEnvelope(storage).env;
}

/** Returns whether the write succeeded, so a caller can surface a save-failure status note
 *  instead of the loss being silent (matches store-core.ts's `saveGraphsEnvelope`). */
export function saveRunsEnvelope(storage: StorageLike, env: RunsEnvelope): boolean {
  try {
    storage.setItem(RUNS_KEY, JSON.stringify(env));
    return true;
  } catch {
    return false; // best-effort persistence only, matches store-core.ts's guard
  }
}

/** Same per-key cap as store-core.ts's `MAX_BAK_PER_KEY`/`pruneBakKeys` — restated, not imported,
 *  so this leaf still compiles standalone under node --test. */
const MAX_BAK_PER_KEY = 5;

function pruneBakKeys(storage: StorageLike, newSuffix: string): void {
  const indexKey = `${RUNS_KEY}.bakindex`; // no dash: never matches a "${RUNS_KEY}.bak-" prefix scan
  let list: string[] = [];
  try {
    const raw = storage.getItem(indexKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    list = [];
  }
  // Dedupe: a same-`now` double call within the same millisecond produces the same suffix — an
  // existing entry is dropped before the re-push so the index never lists a suffix twice, which
  // would otherwise leave a stale entry pointing at an already-evicted backup key.
  list = list.filter((s) => s !== newSuffix);
  list.push(newSuffix);
  while (list.length > MAX_BAK_PER_KEY) {
    const old = list.shift();
    if (old !== undefined) {
      try { storage.removeItem(`${RUNS_KEY}.bak-${old}`); } catch { /* best-effort */ }
    }
  }
  try {
    storage.setItem(indexKey, JSON.stringify(list));
  } catch {
    // best-effort — a lost index just means the next prune over-keeps; no data loss
  }
}

/** Copies a present-but-invalid raw envelope string to `${RUNS_KEY}.bak-<stamp>` before a caller
 *  overwrites the key — same rationale and shape as store-core.ts's `backupInvalidEnvelope`, and
 *  the same per-key prune. Returns whether the backup write itself succeeded. */
export function backupInvalidRunsEnvelope(storage: StorageLike, raw: string, now: string): boolean {
  const suffix = now.replace(/[:.]/g, "-");
  let ok = true;
  try {
    storage.setItem(`${RUNS_KEY}.bak-${suffix}`, raw);
  } catch {
    ok = false; // best-effort, same guard as saveRunsEnvelope
  }
  // Only list a backup that actually landed — pushing on failure would leave the index pointing
  // at a key that was never written.
  if (ok) pruneBakKeys(storage, suffix);
  return ok;
}

/** Drops oldest-completed-first runs once `runs.length` exceeds `cap` — a run still
 *  `status:"running"` is never evicted even if it is the oldest record (§4.1: "the cap-50
 *  eviction always drops the oldest completed run first... a run still status:"running" is never
 *  evicted even if it is the oldest record"). "Oldest" is `startedAt` ascending. When every run
 *  over `cap` is `"running"`, the list is returned over-cap rather than dropping a live run —
 *  the next `upsertRun` call re-evicts once one of them finishes. */
export function evict(runs: FlowRun[], cap: number): FlowRun[] {
  if (runs.length <= cap) return runs;
  const order = runs
    .map((r, i) => ({ i, startedAt: r.startedAt }))
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const drop = new Set<number>();
  let over = runs.length - cap;
  for (const { i } of order) {
    if (over <= 0) break;
    if (runs[i].status === "running") continue;
    drop.add(i);
    over--;
  }
  return runs.filter((_, i) => !drop.has(i));
}

const LIVE_NODE_STATUSES = new Set<FlowRunNodeState["status"]>(["queued", "running", "awaiting-approval"]);

/** §4.1 reload/restart rule: every stored run with `status:"running"` that `heldRunIds` (the
 *  runIds the engine actually holds — empty at mount time after a reload/restart, since
 *  `engine.ts`'s scheduler lives in the webview and does not survive one) does not contain
 *  becomes `status:"error"`, `endedAt` = `now`, and each of its `queued`/`running`/
 *  `awaiting-approval` nodes becomes `canceled` with `error:"Interrupted"`. A run already
 *  finished (`success`/`error`/`canceled`) is returned unchanged, whatever `heldRunIds` says.
 *  Returns the updated runs array plus the ids just reconciled — the caller (`runs-store.ts`)
 *  calls `flow_cancel_run` for each (idempotent no-op post-restart, §4.1). */
export function reconcileInterrupted(
  runs: FlowRun[],
  heldRunIds: ReadonlySet<string>,
  now: string,
): { runs: FlowRun[]; reconciledRunIds: string[] } {
  const reconciledRunIds: string[] = [];
  const out = runs.map((run) => {
    if (run.status !== "running" || heldRunIds.has(run.id)) return run;
    reconciledRunIds.push(run.id);
    const nodes: Record<string, FlowRunNodeState> = {};
    for (const [nodeId, node] of Object.entries(run.nodes)) {
      nodes[nodeId] = LIVE_NODE_STATUSES.has(node.status)
        ? { ...node, status: "canceled", error: "Interrupted", endedAt: node.endedAt ?? now }
        : node;
    }
    const status: FlowRunStatus = "error";
    return { ...run, status, endedAt: run.endedAt ?? now, nodes };
  });
  return { runs: out, reconciledRunIds };
}
