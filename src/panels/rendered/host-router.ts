// Host router: the one module-level `agent-event` / `agent-exit` listener pair, routing
// each event to its tab by id and dropping stale backend generations.

import { listen } from "../../ipc";
import type { AgentAdapter, AgentEvent } from "../../agents/protocol";

export interface Live {
  gen: number;
  /** the tab's last spawned generation: anything at or below it is a process this tab
   *  already killed, and adopting one strands the spawn actually in flight */
  floor: number;
  handle: (ev: AgentEvent) => void;
  dropped: (bytes: number) => void;
  exit: (code: number | null) => void;
  adapter: AgentAdapter;
  host: (payload: HostPayload) => void;
}
export interface HostPayload {
  hydration?: "start" | "end";
  hostRecord?: { body?: Record<string, unknown> } & Record<string, unknown>;
  disconnected?: string;
  replay?: boolean;
}
type Item = { line?: string; dropped?: number; gen?: number } & HostPayload;
/** One payload to its tab: the host's own handling first, then the adapter's events for a journal
 *  record (setters another client or a replay applied) or a wire line. */
export function deliver(l: Live, p: Item): void {
  if (p.hydration || p.hostRecord || p.disconnected) l.host(p);
  if (p.hostRecord && l.adapter.hostRecord) {
    const body = (p.hostRecord.body ?? p.hostRecord) as Record<string, unknown>;
    for (const ev of l.adapter.hostRecord(body, p.gen)) l.handle(ev);
  }
  if (typeof p.dropped === "number") { l.dropped(p.dropped); return; }
  if (typeof p.line !== "string") return;
  for (const ev of l.adapter.feed(p.line)) l.handle(ev);
}
const live = new Map<string, Live>();
let listening = false;

/** Routes `id`'s events to `route` from now on, replacing any earlier route for that id. */
export function registerRoute(id: string, route: Live): void {
  live.set(id, route);
}
/** With `route`, drops the id only while the map still holds that same route (a stale
 *  spawn or kill must not unroute a newer one); without it, drops unconditionally. */
export function releaseRoute(id: string, route?: Live): void {
  if (route && live.get(id) !== route) return;
  live.delete(id);
}
export function routeOf(id: string): Live | undefined {
  return live.get(id);
}
/** Disposing an old body must not unregister the replacement body for the same tab. */
export function releaseAdapterRoute(id: string, adapter: AgentAdapter): void {
  const route = live.get(id);
  if (route?.adapter === adapter) releaseRoute(id, route);
}

export async function ensureListeners() {
  if (listening) return;
  listening = true;
  // gen -1 = spawn in flight: the route is registered before transport.spawn
  // resolves, so a fast first line can't slip past; the first event binds it.
  // `kill_agent` returns before the reader thread emits the old process's `agent-exit`
  // (src-tauri/src/agent.rs:431), so on /clear that exit arrives after the new route is
  // registered. Adopting it drew "Process exited (0)" and left the live sidecar's events
  // filtered as stale. Backend gens start at 1 (agent.rs:50) and a fresh
  // tab's floor is 0, so a first spawn is never refused — keep that true if NEXT_GEN moves.
  const bind = (l: Live, gen: number): boolean => {
    if (l.gen === -1) {
      if (gen <= l.floor) return false;
      l.gen = gen;
    }
    return l.gen === gen;
  };
  // A replay arrives as `{ id, gen, batch: [...] }` (one IPC per up to 64 records, same order
  // as singles; src-tauri/src/falcon/events.rs ReplayBatch); live events stay single payloads.
  await listen<{ id: string; gen: number; batch?: Item[] } & Item>("agent-event", (e) => {
    const l = live.get(e.payload.id);
    if (!l || !bind(l, e.payload.gen)) return; // stale generation: an old process talking
    if (Array.isArray(e.payload.batch)) {
      for (const item of e.payload.batch) deliver(l, { ...item, id: e.payload.id, gen: e.payload.gen } as Item);
      return;
    }
    deliver(l, e.payload);
  });
  await listen<{ id: string; gen: number; code: number | null }>("agent-exit", (e) => {
    const l = live.get(e.payload.id);
    if (!l || !bind(l, e.payload.gen)) return;
    l.exit(e.payload.code);
  });
}
