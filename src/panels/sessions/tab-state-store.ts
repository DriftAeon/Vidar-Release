// Tab state by tab id. DOM-free, no timers, no clock: `now` is a parameter. Type imports only.

import type { TabState } from "./tab-state";

type Listener = (id: string, state: TabState | null) => void;

const states = new Map<string, TabState>();
const listeners = new Set<Listener>();

const BLANK: TabState = { phase: "unknown", reason: null, since: 0, ctxPct: null, model: null, tool: null };

/** Merge `partial` into the tab's state; `since` is stamped only when `phase` changes (the first publish stamps too). */
export function publish(id: string, partial: Partial<Omit<TabState, "since">>, now: number): void {
  const prev = states.get(id);
  const next: TabState = { ...(prev ?? BLANK), ...partial, since: prev?.since ?? now };
  if (!prev || next.phase !== prev.phase) next.since = now;
  states.set(id, next);
  for (const fn of [...listeners]) fn(id, next);
}

export function get(id: string): TabState | null {
  return states.get(id) ?? null;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Remove a tab; subscribers are called once with `null` as the state (a removal), only if it existed. */
export function drop(id: string): void {
  if (!states.delete(id)) return;
  for (const fn of [...listeners]) fn(id, null);
}
