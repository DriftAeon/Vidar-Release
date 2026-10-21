// Run-history wiring: vidar.flow.runs.v1 via the Flow file store (file-storage.ts), reconciled on mount.
//
// Owns the full FlowRun[] list itself — state.ts is additive-only and holds only
// per-node/per-output/pending-approval maps (keyed
// by runId), not a FlowRun[] array — so the list lives here; run-view.ts and panels/flow.ts
// read it through this module's exports rather than through S.

import type { FlowRun } from "./run";
import {
  RUNS_CAP,
  backupInvalidRunsEnvelope,
  evict,
  reconcileInterrupted,
  readRunsEnvelope,
  saveRunsEnvelope,
} from "./runs-core";
import { invoke } from "../ipc";
import { flowStorage } from "./file-storage";

let runs: FlowRun[] = [];
let initPromise: Promise<void> | null = null;
const observers = new Set<() => void>();

/** One subscriber slot for a failed `saveRunsEnvelope` write — panels/flow.ts wires this to the
 *  Flow toast (viewport.ts's `showFlowToast`), same seam as store.ts's `onSaveFailed` (a failed
 *  run-history write must not be silent). */
let saveFailedCb: (() => void) | null = null;

export function onSaveFailed(cb: () => void): void {
  saveFailedCb = cb;
}

/** One subscriber slot for a run-record change — panels/flow.ts wires this to the
 *  toolbar's `refresh(); updateRunGate()`, which replaced its 500 ms poll. Fired from `upsertRun`,
 *  the single writer, in a microtask: engine.ts's `finishRun` persists before it drops the run
 *  from its held set, so a synchronous call would still see the finished run as live. */
let runStatusChangedCb: (() => void) | null = null;

export function onRunStatusChanged(cb: () => void): void {
  runStatusChangedCb = cb;
}

/** Independent of the panel's single callback. */
export function subscribeRuns(cb: () => void): () => void {
  observers.add(cb);
  return () => { observers.delete(cb); };
}

function now(): string {
  return new Date().toISOString();
}

function persist(): void {
  if (!saveRunsEnvelope(flowStorage(), { v: 1, runs })) {
    try { saveFailedCb?.(); } catch (error) { console.error("[flow] run save notification failed:", error); }
  }
}

/** `engine.ts` persists through this module's own `upsertRun` (not
 *  a second writer of `vidar.flow.runs.v1`), so `runs` and storage never drift from each other in
 *  this session — every read here trusts the in-memory list rather than re-parsing the storage key
 *  (`run-view.ts`'s per-event subscriber called `getRun` up to 4 Hz per
 *  node, each call JSON-parsing the whole envelope). This session's own writes are the only ones
 *  v1 needs to stay consistent with; a second tab/session writing the same key mid-session is not
 *  a supported case. */

/** §5 run selector: a graph's own runs, newest first. */
export function runsForGraph(graphId: string): FlowRun[] {
  return runs
    .filter((r) => r.graphId === graphId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function getRun(runId: string): FlowRun | undefined {
  return runs.find((r) => r.id === runId);
}

/** Loads `vidar.flow.runs.v1`, reconciles any run still `status:"running"` that `heldRunIds`
 *  doesn't hold (§4.1 — at Flow mount that is every such run: `engine.ts`'s scheduler lives in
 *  the webview and does not survive a reload/restart, so the caller passes an empty set unless a
 *  live engine instance already exists in this same session), persists the reconciled result,
 *  and calls `flow_cancel_run` for each reconciled run (idempotent no-op after a real restart,
 *  §4.1 — the record for it already reads "no live run to cancel"). Call once at Flow mount.
 *
 *  A second call in the same
 *  webview session (panel remount, re-init after a graph reset) would mark every run the engine
 *  is mid-executing "Interrupted" and cancel it, since `heldRunIds` defaults to empty and
 *  `runner-adapter.ts` doesn't yet export the engine's real held set for a caller to pass
 *  instead. Guarded to a no-op past the first call until that accessor exists. */
export function initRunsStore(heldRunIds: ReadonlySet<string> = new Set()): Promise<void> {
  if (!initPromise) initPromise = loadRuns(heldRunIds);
  return initPromise;
}

async function loadRuns(heldRunIds: ReadonlySet<string>): Promise<void> {
  const storage = flowStorage();
  const nowStr = now();
  const read = readRunsEnvelope(storage);
  if (read.status === "invalid") backupInvalidRunsEnvelope(storage, read.raw, nowStr);
  const loaded = read.status === "ok" ? read.env.runs : [];

  const { runs: reconciled, reconciledRunIds } = reconcileInterrupted(loaded, heldRunIds, nowStr);
  runs = evict(reconciled, RUNS_CAP);
  persist();

  for (const runId of reconciledRunIds) {
    try {
      await invoke("flow_cancel_run", { runId });
    } catch {
      // best-effort: a no-op after a real restart anyway, and a failed cancel call here must
      // not block the rest of Flow mounting
    }
  }
}

/** Adds or replaces a run record (by id), evicting to `RUNS_CAP` per §4.1 (`runs-core.ts`'s
 *  `evict`, which never drops a still-`running` run). Called by `engine.ts` (RUN click and every
 *  node status transition, §4.1) — exported here since this module owns the in-memory list and
 *  the storage key `engine.ts` writes through. */
export function upsertRun(run: FlowRun): void {
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx === -1) runs.push(run);
  else runs[idx] = run;
  runs = evict(runs, RUNS_CAP);
  persist();
  queueMicrotask(() => {
    try { runStatusChangedCb?.(); } catch (error) { console.error("[flow] run status notification failed:", error); }
    for (const cb of observers) {
      try { cb(); } catch (error) { console.error("[flow] run observer failed:", error); }
    }
  });
}
