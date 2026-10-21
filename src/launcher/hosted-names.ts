// A renamed hosted Claude tab's title, remembered per Falcon session in the `rendered.hostedNames`
// pref (vidar-state.json). The host keeps only the spawn-time `VIDAR_TAB_NAME`, so a swap re-adopt
// would otherwise bring the old name back. Entries die with the session: `prune` drops every
// session the host no longer lists. Leaf module over injected get/set so `node --test` loads it.

type HostedNames = Record<string, string>;

export interface HostedNamesDeps {
  get: () => HostedNames | undefined;
  set: (m: HostedNames) => void;
}

export function createHostedNames(deps: HostedNamesDeps) {
  return {
    /** The remembered rename of a Falcon session, or undefined. */
    get(session: string | null | undefined): string | undefined {
      return session ? deps.get()?.[session] : undefined;
    },
    /** A rename of a hosted tab. */
    remember(session: string | null | undefined, title: string): void {
      const name = title.trim();
      if (!session || !name) return;
      const cur = deps.get() ?? {};
      if (cur[session] === name) return;
      deps.set({ ...cur, [session]: name });
    },
    /** Drop the entries of sessions the host no longer lists (ended). */
    prune(live: Iterable<string>): void {
      const cur = deps.get();
      if (!cur) return;
      const keep = new Set(live);
      const next: HostedNames = {};
      let dropped = false;
      for (const [k, v] of Object.entries(cur)) {
        if (keep.has(k)) next[k] = v;
        else dropped = true;
      }
      if (dropped) deps.set(next);
    },
  };
}
