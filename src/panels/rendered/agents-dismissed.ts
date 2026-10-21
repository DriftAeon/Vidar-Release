// Dismissed background-agent rows, remembered per Claude session so a transcript replay (reload,
// re-adopt) does not bring cleared rows back. Only row visibility is cached; the transcript data
// stays. Leaf module (no imports) so `node --test` loads it; agents-block.ts wires it to the
// `rendered.dismissedAgents` pref (vidar-state.json under the Vidar folder; guard in prefs-core.ts).
//
// Bound: at most MAX_IDS ids per session (oldest dropped), MAX_SESSIONS sessions (least recently
// touched dropped), and a session untouched for MAX_AGE_MS is dropped on the next write.

interface DismissedEntry { t: number; ids: string[] }
type DismissedMap = Record<string, DismissedEntry>;

export const MAX_IDS = 200;
export const MAX_SESSIONS = 40;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DismissedDeps {
  get: () => DismissedMap | undefined;
  set: (m: DismissedMap) => void;
  now?: () => number;
}

export function createDismissedStore(deps: DismissedDeps) {
  const now = deps.now ?? Date.now;
  return {
    has(sessionId: string | null, taskId: string): boolean {
      if (!sessionId) return false;
      return deps.get()?.[sessionId]?.ids.includes(taskId) ?? false;
    },
    add(sessionId: string | null, taskIds: string[]): void {
      if (!sessionId || !taskIds.length) return;
      const t = now();
      const map: DismissedMap = {};
      for (const [k, e] of Object.entries(deps.get() ?? {})) if (t - e.t <= MAX_AGE_MS) map[k] = e;
      const ids = [...(map[sessionId]?.ids ?? [])];
      for (const id of taskIds) if (!ids.includes(id)) ids.push(id);
      map[sessionId] = { t, ids: ids.slice(-MAX_IDS) };
      const keys = Object.keys(map);
      if (keys.length > MAX_SESSIONS) {
        keys.sort((a, b) => map[a].t - map[b].t);
        for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete map[k];
      }
      deps.set(map);
    },
    /** a cleared agent resumed live: its row is back, so a later replay must show it too */
    remove(sessionId: string | null, taskId: string): void {
      if (!sessionId) return;
      const map = { ...(deps.get() ?? {}) };
      const e = map[sessionId];
      if (!e || !e.ids.includes(taskId)) return;
      map[sessionId] = { t: now(), ids: e.ids.filter((id) => id !== taskId) };
      deps.set(map);
    },
  };
}
