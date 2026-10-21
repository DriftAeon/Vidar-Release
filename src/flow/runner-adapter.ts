// Multi-subscriber hub for `flow.rs`'s `flow-node-event` Tauri payload, normalized to
// `FlowNodeEvent` (§2 — the Rust struct is already camelCase-serialized to match it field for
// field). engine.ts (scheduling) and run-view.ts (painting) each
// register their own callback here, unlike edges.ts's single-slot `onSelectionChanged`
// (VERIFIED edges.ts:13-17, one `let ... | null` ref) — §2's comment on this module.
// Drop rules: §4.1.

import { listen } from "../ipc";
import type { FlowNodeEvent } from "./run";

export type FlowNodeEventHandler = (event: FlowNodeEvent) => void;

const subscribers: FlowNodeEventHandler[] = [];

/** Run ids the engine currently holds — an event for any other runId is a late/orphaned
 *  emission (after a reload the old run's children are still draining, its stored record is
 *  already reconciled to "Interrupted", §4.1) and is dropped here, once, rather than by every
 *  subscriber separately. */
const heldRunIds = new Set<string>();

/** Current attempt number per `${runId}:${nodeId}` — an event for any other attempt is a
 *  cancelled or retried child still draining and is dropped the same way. Unset (no entry) means
 *  "no attempt recorded yet for this node", which never drops an event — engine.ts sets this
 *  before starting an attempt, so in practice an event always finds an entry. */
const currentAttempt = new Map<string, number>();

function attemptKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

/** Call when a run starts (RUN click) — until this, every event for that runId is dropped. */
export function markRunHeld(runId: string): void {
  heldRunIds.add(runId);
}

/** Call when a run ends (success/error/canceled) or is reconciled to "Interrupted" on mount —
 *  drops every later event for it, including ones already in flight from a still-draining
 *  child. */
export function markRunUnheld(runId: string): void {
  heldRunIds.delete(runId);
  for (const key of currentAttempt.keys()) {
    if (key.startsWith(`${runId}:`)) currentAttempt.delete(key);
  }
}

/** Call before starting attempt `attempt` on `nodeId` — events for any earlier attempt of that
 *  node are then dropped as stale. */
export function setCurrentAttempt(runId: string, nodeId: string, attempt: number): void {
  currentAttempt.set(attemptKey(runId, nodeId), attempt);
}

/** Registers a subscriber; returns an unsubscribe function. */
export function onFlowNodeEvent(handler: FlowNodeEventHandler): () => void {
  subscribers.push(handler);
  return () => {
    const idx = subscribers.indexOf(handler);
    if (idx !== -1) subscribers.splice(idx, 1);
  };
}

function isDeliverable(event: FlowNodeEvent): boolean {
  if (!heldRunIds.has(event.runId)) return false;
  const current = currentAttempt.get(attemptKey(event.runId, event.nodeId));
  if (current !== undefined && event.attempt !== current) return false;
  return true;
}

let started = false;

/** Registers the one Tauri listener for `flow-node-event`, fanning each held/current-attempt
 *  event out to every subscriber. Idempotent — safe to call from more than one caller's init
 *  path. */
export function startRunnerAdapter(): void {
  if (started) return;
  started = true;
  void listen<FlowNodeEvent>("flow-node-event", (e) => {
    const event = e.payload;
    if (!isDeliverable(event)) return;
    for (const handler of subscribers.slice()) handler(event);
  });
}
