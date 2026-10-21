// What the CLI update check last learned, shared with Settings › Dependencies. The check only reports
// CLIs with a newer release, so a version is known for those rows alone. No imports beyond types: the
// page reads this without loading the update card (sessions, toasts).
import type { CliUpdate, CliUpdateBusy } from "./core";

export interface KnownUpdates {
  updates: CliUpdate[];
  busy: CliUpdateBusy | null;
  error: string | null;
}

let known: KnownUpdates = { updates: [], busy: null, error: null };
const listeners = new Set<() => void>();
/** Set by the mounted update card: runs Update or Skip for one CLI; returns why it cannot, or null. */
let actor: ((u: CliUpdate, skip: boolean) => string | null) | null = null;

export function knownUpdates(): KnownUpdates {
  return known;
}

/** The card calls this on every state change; the Dependencies page repaints from it. */
export function publishUpdates(next: KnownUpdates): void {
  known = next;
  for (const cb of [...listeners]) cb();
}

export function onKnownUpdates(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function setUpdateActor(fn: ((u: CliUpdate, skip: boolean) => string | null) | null): void {
  actor = fn;
}

/** Update or Skip from the page. Null when started; otherwise the reason it did not. */
export function requestUpdate(u: CliUpdate, skip: boolean): string | null {
  return actor ? actor(u, skip) : "No Update Offer Open: Check for Updates First";
}
