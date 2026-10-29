// Claude login of a logged-out Rendered tab: the Codex Login Card (api-key-card.ts loginCard, no
// new look) with one action. Log In runs `claude auth login` against the tab's own home in its own
// console window (src-tauri claude_login.rs: a Bare tab's profile home, else the default home) and
// the card waits on it; Cancel ends that process. When the process exits the card re-checks
// `claude auth status` against the same home: logged in folds the card and respawns the session so
// it reads the new credentials, still logged out puts the reason in the card. The status-bar pill
// (Not Logged In) opens the card, as Codex's pill drives its card.

import { invoke } from "../../ipc";
import { DRIVE_CLASS } from "../rendered-drive";
import { btn } from "./dom";
import { codexLogin, loginCard, type CodexLoginDeps, type LoginCard } from "./api-key-card";
import type { AgentAdapter } from "../../agents/protocol";
import type { AgentTransport, RenderedAgent } from "./transport";

// The tip wording lives in agents/login-tips.ts; these names stay importable from here.
import { LOGIN_TIP, claudeReach, type ClaudeReach } from "../../agents/login-tips";
export { LOGIN_TIP, LOGIN_TIP_NO_CARD, LOGIN_TIP_REFUSED, LOGIN_TIP_GATEWAY, claudeReach, claudeLoginTip } from "../../agents/login-tips";
export type { ClaudeReach } from "../../agents/login-tips";
export const CLAUDE_LOGIN_TITLE = "Log In To Claude";
export const CLAUDE_LOGIN_ACTION = "Log In";
/** the login process exited (or was closed) and the status check still says logged out */
export const CLAUDE_LOGIN_STILL_OUT = "The login window closed and Claude Code is still not logged in.";
export const CLAUDE_LOGIN_TIMED_OUT = "The login waited 15 minutes without finishing and was ended.";
/** the login process exited and the status check could not be read (null) */
export const CLAUDE_LOGIN_UNKNOWN = "The login window closed, but Claude Code's login status could not be read.";

export interface LoginExit { code: number | null; cancelled: boolean; timedOut: boolean }

export interface ClaudeLoginCalls {
  /** runs `claude auth login` for this tab's home; resolves when it exits */
  run: () => Promise<LoginExit>;
  /** ends the running login */
  cancel: () => Promise<unknown>;
  /** `claude auth status` for the same home: true, false, or null (unknown) */
  check: () => Promise<boolean | null>;
}

/** The Tauri calls for a tab: a bare tab's status is its profile home's, no profile the default
 *  home's; any other profile is refused without a call, as claude_login_run refuses its login. */
export function claudeLoginCalls(tab: string, profile: string | null): ClaudeLoginCalls {
  return {
    run: () => invoke("claude_login_run", { tab, profile }),
    cancel: () => invoke("claude_login_cancel", { tab }),
    check: () => (profile === "bare" ? invoke("claude_auth_status_bare")
      : profile ? Promise.reject(new Error(`No Claude home for the "${profile}" profile`))
      : invoke("claude_auth_status")),
  };
}

export interface ClaudeLoginDeps extends ClaudeLoginCalls {
  /** false: the pill and the redraw offer no card (a host without the commands, a gateway tab, a refused respawn) */
  available: boolean;
  /** why the card is unavailable, for the tip (login.ts claudeReach); unset reads as "outside" */
  reach?: ClaudeReach;
  /** the tab is still logged out (S.loggedOut): a finished login respawns only then */
  loggedOut: () => boolean;
  /** puts the card at the end of the transcript (rendered.ts: seal the open group, append) */
  mount: (card: HTMLElement) => void;
  /** the check said logged in: clear the tab's logged-out state and respawn the session */
  loggedIn: () => void;
}

/** The same shape as codexLogin's, so the status bar drives either; `open` is the pill's press. */
export function claudeLogin(deps: ClaudeLoginDeps) {
  let current: LoginCard | null = null;
  let mounting = false;
  let attempt = 0;
  let disposed = false; // the tab closed: a login that settles after that never respawns
  const live = () => (current?.card.isConnected && current.view() !== "done" ? current : null);
  const settled = (c: LoginCard, v: boolean | null, failure: string | null) => {
    if (disposed) return;
    if (v === true) {
      // a card that already folded (a clean turn, another login) or a tab no longer logged out
      // needs no respawn: the session already has working credentials. The once-only guard is
      // S.loggedOut: loggedIn() flips it (login.ts fromAgent(true)), so a later settle sees false.
      const open = c.view() !== "done";
      c.fold();
      if (open && deps.loggedOut()) deps.loggedIn();
      return;
    }
    if (failure) c.choice(failure);
  };
  const start = (c: LoginCard) => {
    const mine = ++attempt;
    c.pending();
    deps.run().then(
      (exit) => deps.check().catch(() => null).then((v) => {
        // a Cancel or a second Log In owns the card now; only a login is still worth folding for
        const owns = mine === attempt && !exit.cancelled;
        const failure = !owns ? null : exit.timedOut ? CLAUDE_LOGIN_TIMED_OUT
          : v === false ? CLAUDE_LOGIN_STILL_OUT : CLAUDE_LOGIN_UNKNOWN;
        settled(c, v, failure);
      }),
      (error) => { if (mine === attempt) c.choice(String(error)); },
    );
  };
  const ensure = (): LoginCard => {
    const have = live() ?? (mounting ? current : null);
    if (have) return have;
    current?.drop();
    const c: LoginCard = loginCard(
      { chatgpt: () => start(c), apiKey: () => {}, cancel: () => { attempt++; void deps.cancel().catch(() => {}); } },
      { title: CLAUDE_LOGIN_TITLE, choices: () => [btn(CLAUDE_LOGIN_ACTION, DRIVE_CLASS.allow, () => start(c))] },
    );
    current = c;
    mounting = true; // a redraw the mount triggers must not offer a second card
    try { deps.mount(c.card); } finally { mounting = false; }
    // the card replaces the warn tip the flip just drew (login.ts), which sits right above it
    const prev = c.card.previousElementSibling;
    if (prev?.classList.contains("blk-notice") && prev.textContent === LOGIN_TIP) prev.remove();
    return c;
  };
  return {
    offered: () => deps.available,
    /** picks the no-card tip (login.ts loginTip): "card" whenever the card is available */
    reach: (): ClaudeReach => (deps.available ? "card" : deps.reach && deps.reach !== "card" ? deps.reach : "outside"),
    ready: () => true,
    offer: () => { if (deps.available) ensure(); },
    settle: () => { live()?.fold(); },
    fail: (_text: string) => false,
    /** the pill: brings the card up (mounting it if a /clear dropped it) and focuses its action */
    open: () => {
      if (!deps.available) return;
      const c = ensure();
      c.card.scrollIntoView?.({ block: "nearest" });
      c.card.querySelector<HTMLButtonElement>(".approval-actions button")?.focus();
    },
    chatgpt: () => { if (deps.available) start(ensure()); },
    apiKey: () => {},
    /** the tab closed (rendered.ts dispose): end a running login so no console outlives it */
    dispose: () => { disposed = true; attempt++; if (deps.available) void deps.cancel().catch(() => {}); },
  };
}

/** `claude auth status` for a tab's home (rendered.ts login check): a profiled tab's is its profile home's. */
export const claudeStatus = (transport: AgentTransport) => claudeLoginCalls("", transport.profile ?? null).check;

export interface TabLoginDeps extends CodexLoginDeps {
  opts: { tabId: string; agent: RenderedAgent };
  transport: AgentTransport;
  /** the host registers claude_login_run (host-profile.ts loginRun; rendered.ts asks) */
  hostCan: boolean;
  /** the login state's own flip (login.ts fromAgent(true)) */
  loggedIn: () => void;
  stopAgent: () => Promise<void>;
  spawn: () => Promise<void>;
}

/** The status bar's login for a tab: Claude's card (not on a gateway tab: its vendor holds the
 *  identity; not where respawn is refused: the respawn would throw), else Codex's. A Claude login
 *  respawns the session so it reads the new credentials, as /clear does, keeping the session id
 *  so the conversation resumes. */
export function tabLogin(S: { adapter: AgentAdapter; isAlive: boolean; loggedOut: boolean; sessionId?: string | null }, deps: TabLoginDeps) {
  if (deps.opts.agent !== "claude") return codexLogin(S, deps);
  const reach = claudeReach(deps.hostCan, deps.transport);
  return claudeLogin({
    ...claudeLoginCalls(deps.opts.tabId, deps.transport.profile ?? null),
    available: reach === "card",
    reach,
    loggedOut: () => S.loggedOut,
    mount: deps.mount,
    loggedIn: () => {
      deps.loggedIn();
      void (async () => { if (S.isAlive) await deps.stopAgent(); await deps.spawn(); })()
        .catch((e) => deps.noticeBlock(String(e), "error"));
    },
  });
}
