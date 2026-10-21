// src\control\requester.ts — `ctl.*` requester -> own tab id. Pure (no IPC, no
// sessions import) so `tests\control-requester.test.mjs` can load it directly;
// `listen.ts` and `registry.ts` pass `findTabByFalconSession` as `lookup`.

export interface Requester {
  kind: "token" | "falcon_session";
  /** `token`: always set. `falcon_session`: set by Rust when `falcon.hosted`
   *  holds the session (a spawned hosted tab, `control\policy.rs`
   *  `attach_hosted_tab`); absent for adopted tabs. */
  tab?: string;
  session?: string;
}

/** A Rust-supplied `tab` wins; a bare `falcon_session` falls back to the
 *  frontend's session -> tab map (adopted tabs carry `falconSession`). */
export function resolveRequesterTab(r: Requester, lookup: (session: string) => string | null): string | null {
  if (r.kind === "token") return r.tab ?? null;
  if (r.kind === "falcon_session") {
    if (r.tab) return r.tab;
    return r.session ? lookup(r.session) : null;
  }
  return null;
}
