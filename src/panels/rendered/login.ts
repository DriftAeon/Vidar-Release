// Login state of a Rendered tab. A Codex tab has one source, its app-server's account state
// (`fromAgent`). A Claude tab has two: `claude auth status` (src-tauri
// claude_auth.rs) on every spawn, on hosts that register it, and the CLI's own reply to a turn
// (`Not logged in · Please run /login`, friend first-run smoke 2026-10-08). A clean turn or a
// spawn whose check says logged in clears it. Import-free: the check is passed in, so tests load
// this under Node type stripping.

/** How a logged-out tab gets back in: the Login Card, or (no card) a gateway's key, a new tab where
 *  respawn is refused, or a login outside Vidar. Each agent's profile words the tip (agent-profile.ts
 *  `loginTip`); an agent with one tip ignores it. */
export type LoginReach = "card" | "gateway" | "refused" | "outside";

/** True for the CLI's reply when it has no credentials: the whole diagnostic at the start, so model
 *  prose that opens with "Not logged in" or quotes it mid-sentence does not count (review 89e6032a). */
export function saysNotLoggedIn(text: string): boolean {
  return /^\s*not logged in\s*·\s*please run \/login/i.test(text);
}

/** True for the CLI's reply when its credentials stopped working, e.g. "Failed to authenticate: OAuth
 *  session expired and could not be refreshed" (2026-10-21: a dead shared refresh token never showed
 *  the Login Card). Only an error turn counts, and the general "Failed to authenticate" only at the
 *  start, so model prose about some other service's auth does not log the tab out. */
export function saysAuthFailed(text: string, clean: boolean): boolean {
  return !clean && /^\s*failed to authenticate\b|oauth session expired and could not be refreshed/i.test(text);
}

/** The spawn check rendered.ts passes: only a tab whose profile has a login check (`loginCheck`, Claude's
 *  `claude auth status`) on a host that registers it runs `run`; any other tab (Codex) resolves null
 *  without a call, as does a failed run. */
export function authCheck(loginCheck: boolean, hostCan: boolean, run: () => Promise<boolean | null>): () => Promise<boolean | null> {
  return () => (loginCheck && hostCan ? run().catch(() => null) : Promise.resolve(null));
}

export interface LoginDeps {
  /** Only a Claude tab reads replies for the CLI's diagnostic; a Codex reply never sets it. */
  claude: boolean;
  /** The tab's way back in (claude-login.ts `reach`); unset reads as "card". Picks the tip's wording. */
  reach?: () => LoginReach;
  /** The agent profile's tip wording (agent-profile.ts `loginTip`). */
  tip: (reach: LoginReach) => string;
  /** `true`/`false` from `claude auth status`; `null` when unknown (no claude, odd output, no host command). */
  check: () => Promise<boolean | null>;
  noticeBlock: (text: string, level: "info" | "warn" | "error", quiet?: boolean) => void;
  redrawStatus: () => void;
  refreshState: () => void;
}

export function createLogin(S: { loggedOut: boolean; disposed: boolean }, deps: LoginDeps) {
  function set(out: boolean): void {
    if (S.disposed || S.loggedOut === out) return;
    S.loggedOut = out;
    if (out) deps.noticeBlock(deps.tip(deps.reach?.() ?? "card"), "warn"); // once per flip, not per failed turn
    deps.redrawStatus();
    deps.refreshState();
  }
  // Newest evidence wins: a check that resolves after a later turn or a later check is dropped.
  let seq = 0;
  return {
    /** On each spawn: an unknown answer leaves the state alone. */
    check(): void {
      const mine = ++seq;
      void deps.check().then((v) => { if (v !== null && mine === seq) set(!v); }, () => {});
    },
    /** On each live turn's end: the CLI's not-logged-in reply sets it, a clean turn clears it. */
    sawTurn(resultText: string, clean: boolean): void {
      if (!deps.claude) return;
      seq++;
      if (saysNotLoggedIn(resultText) || saysAuthFailed(resultText, clean)) set(true);
      else if (clean) set(false);
    },
    /** The agent's own account state (Codex account/read, a completed login): newest evidence, always applied. */
    fromAgent(loggedIn: boolean): void {
      seq++;
      set(!loggedIn);
    },
  };
}
