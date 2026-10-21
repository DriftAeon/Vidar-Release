// Saved strip order across Falcon re-adopts and in-process Codex restores.
// The insertion calculation is pure; the strip and prefs are injected by sessions.ts.
import type { TerminalSession } from "./types";

export function insertionBefore(
  live: readonly string[], keys: ReadonlyMap<string, string>, saved: readonly string[], incoming: string,
): string | null {
  const slot = saved.indexOf(incoming);
  if (slot < 0) return null;
  for (const id of live) {
    if (keys.get(id) === incoming) continue;
    const other = saved.indexOf(keys.get(id) ?? "");
    if (other < 0 || other > slot) return id;
  }
  return null;
}

function key(s: TerminalSession): string | null {
  if (s.falconSession || s.tabOrderFalconSession) return `h:${s.falconSession ?? s.tabOrderFalconSession}`;
  if (s.agent === "codex" && s.body === "rendered" && !s.profile && !s.rendered?.hosted() && s.tabKey) return `c:${s.tabKey}`;
  return null;
}

interface Deps {
  sessions: ReadonlyMap<string, TerminalSession>;
  orderedIds: () => string[];
  moveBefore: (id: string, before: string | null) => void;
  read: () => string[] | undefined;
  write: (order: string[]) => void;
}

let deps: Deps | undefined;
let saved: string[] = [];
let restoring = false;
let restoreCap: ReturnType<typeof setTimeout> | undefined;

/** The boot restores (readopt, Codex restore) have no timeout of their own: a hung probe, list or
 *  adopt would keep saveTabOrder a no-op all session and the next relaunch would restore a stale
 *  order (C6). Readopt runs its adopts one at a time, each capped at 10 s (adopt-settle.ts). */
export const TAB_ORDER_RESTORE_CAP_MS = 120_000;

export function bindTabOrder(next: Deps): void { deps = next; }

export function beginTabOrderRestore(capMs = TAB_ORDER_RESTORE_CAP_MS): void {
  saved = deps?.read() ?? [];
  restoring = true;
  clearTimeout(restoreCap);
  restoreCap = setTimeout(() => {
    if (!restoring) return;
    console.error(`tab order: boot restore still running after ${capMs} ms; saving resumes now`);
    endTabOrderRestore();
  }, capMs);
}

export function placeRestoredTab(id: string): void {
  if (!restoring || !deps) return;
  const incoming = deps.sessions.get(id);
  const identity = incoming && key(incoming);
  if (!identity) return;
  const keys = new Map<string, string>();
  for (const [tab, session] of deps.sessions) {
    const value = key(session);
    if (value) keys.set(tab, value);
  }
  const before = insertionBefore(deps.orderedIds(), keys, saved, identity);
  if (before) deps.moveBefore(id, before);
}

export function saveTabOrder(): void {
  if (restoring || !deps) return;
  const order = deps.orderedIds().flatMap((id) => {
    const session = deps!.sessions.get(id);
    const identity = session && key(session);
    return identity ? [identity] : [];
  });
  deps.write(order);
}

export function endTabOrderRestore(): void {
  clearTimeout(restoreCap);
  restoreCap = undefined;
  if (!restoring) return; // the cap already ended it; the late settle saves nothing twice
  restoring = false;
  saveTabOrder();
}
