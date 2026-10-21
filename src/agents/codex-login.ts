// Login state of a Codex app-server session (split from codex.ts): account/read's answer, the
// account/login/start reply in both methods, account/login/completed and account/updated. Shapes
// pinned from `codex app-server generate-json-schema --experimental` (0.162.1): LoginAccountParams
// `{type:"chatgpt"}` | `{type:"apiKey", apiKey}`; LoginAccountResponse `{type:"chatgpt", authUrl,
// loginId}` | `{type:"apiKey"}`; GetAccountResponse `{account|null, requiresOpenaiAuth}`. The server
// does not open the browser for a ChatGPT login (authUrl: "the client should open").
// An API key goes on the wire once; while its login is in flight every server line is masked
// before parsing, so no event, notice or error text can carry it.

import type { AgentEvent, LoginMethod } from "./protocol";

type Json = Record<string, unknown>;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** The only origin a ChatGPT login link may point at before Vidar opens it in the browser. */
export const LOGIN_ORIGIN = "https://auth.openai.com/";
/** send_failed reason for a turn refused while account/read said logged out. */
export const NOT_LOGGED_IN_REASON = "Codex is not logged in";
/** send_failed reason for a draft the process never took before it exited (CodexAdapter.exited). */
export const EXITED_REASON = "Codex exited before it was sent";
/** failed() reasons for a login that cannot complete: the process exited, or its request was never written */
const EXITED_LOGIN = "Codex exited before the login finished";
const UNSENT_LOGIN = "the login request could not be sent";
/** What an API key is replaced with in any server text (an error echoing it). */
const KEY_MASK = "[api key]";

export class CodexLogin {
  /** account/read's answer: null until it lands (or when it failed), so an unknown state never blocks a turn */
  loggedOut: boolean | null = null;
  /** the API key of a login in flight, held only to mask it out of server lines until the login settles */
  private key: string | null = null;
  /** an account/read is unanswered: app-server need not answer in send order, so turns wait for it */
  private reading = false;
  /** drafts waiting on that read */
  private held: string[] = [];
  private attempt = 0;
  private loginId: string | null = null;
  private cancelWanted = false;
  private canceledIds = new Set<string>();
  /** a login went out and has not settled (logged in, failed or cancelled): an exit fails it */
  private open = false;

  /** the initialize reply has landed (its handler sends the first account/read): a login can go out */
  ready = false;

  /** sends account/read through `request` and marks it in flight */
  ask(request: () => void): void {
    this.ready = true;
    this.reading = true;
    request();
  }
  /** Before a turn: null sends it now. A read in flight holds it; logged out holds it and reads again,
   *  so a login made outside this process (a terminal, another tab on this home) lets it through. */
  gate(text: string, request: () => void): AgentEvent[] | null {
    if (!this.reading && this.loggedOut !== true) return null;
    this.held.push(text);
    if (!this.reading) this.ask(request);
    return [];
  }
  /** account/read answered (`result`) or failed (null, the state stays as it was): the held drafts go
   *  through `send`, or come back as send_failed while it still says logged out */
  settle(result: Json | null, send: (text: string) => AgentEvent[]): AgentEvent[] {
    this.reading = false;
    const out = result ? this.read(result) : [];
    for (const text of this.held.splice(0)) {
      out.push(...(this.loggedOut === true ? [{ kind: "send_failed" as const, text, reason: NOT_LOGGED_IN_REASON }] : send(text)));
    }
    return out;
  }

  /** The session ended or never opened with drafts still held on an unanswered read: hand them
   *  back to come out as send_failed (C5); the read is abandoned. */
  drain(): string[] {
    this.reading = false;
    return this.held.splice(0);
  }

  /** a server line with the key in flight masked, as typed and as it sits JSON-escaped */
  mask(line: string): string {
    if (!this.key) return line;
    for (const k of [this.key, JSON.stringify(this.key).slice(1, -1)]) if (line.includes(k)) line = line.split(k).join(KEY_MASK);
    return line;
  }
  /** account/login/start params; null (nothing to send) for a blank key */
  params(method: LoginMethod): Json | null {
    const apiKey = method === "chatgpt" ? null : method.apiKey.trim();
    if (apiKey === "") return null;
    this.attempt++;
    this.loginId = null;
    this.cancelWanted = false;
    this.open = true;
    if (apiKey === null) return { type: "chatgpt" };
    this.key = apiKey;
    return { type: "apiKey", apiKey };
  }
  /** `send` returns the write's outcome where the transport reports one: a write that resolves
   *  false fails this attempt through `emit`, so the card does not wait on a request never sent */
  start(method: LoginMethod, send: (params: Json, attempt: number) => unknown, emit: (ev: AgentEvent) => void): null {
    const params = this.params(method);
    if (!params) return null;
    const attempt = this.attempt;
    void Promise.resolve(send(params, attempt)).then((ok) => {
      if (ok === false && attempt === this.attempt && this.open) for (const ev of this.failed(UNSENT_LOGIN)) emit(ev);
    });
    return null;
  }
  /** The process exited: a login still out never completes, so it fails (the card returns to its choice). */
  exited(): AgentEvent[] {
    return this.open ? this.failed(EXITED_LOGIN) : [];
  }
  get loginAttempt(): number { return this.attempt; }
  cancel(send: (loginId: string) => void): null {
    this.open = false;
    this.cancelWanted = true;
    if (this.loginId) this.sendCancel(this.loginId, send);
    return null;
  }
  private sendCancel(loginId: string, send: (loginId: string) => void): void {
    if (this.canceledIds.has(loginId)) return;
    this.canceledIds.add(loginId);
    send(loginId);
  }
  /** GetAccountResponse: an account, or no account where none is required (a custom provider) */
  read(result: Json): AgentEvent[] {
    const loggedIn = obj(result.account) !== null || result.requiresOpenaiAuth === false;
    this.loggedOut = !loggedIn;
    return [{ kind: "auth", loggedIn }];
  }
  started(result: Json, attempt: number, sendCancel: (loginId: string) => void): AgentEvent[] {
    const type = str(result.type);
    if (attempt !== this.attempt) {
      // a later attempt replaced this one: a ChatGPT login it started still holds the callback port
      const stale = type === "chatgpt" ? str(result.loginId) : "";
      if (stale) this.sendCancel(stale, sendCancel);
      return [];
    }
    if (type === "apiKey") return this.loggedIn();
    if (type === "chatgpt") {
      const loginId = str(result.loginId);
      this.loginId = loginId || null;
      if (this.cancelWanted) { if (loginId) this.sendCancel(loginId, sendCancel); return []; }
      const url = str(result.authUrl);
      if (!url.startsWith(LOGIN_ORIGIN)) return [{ kind: "notice", text: "Codex sent a login link outside auth.openai.com; it was not opened", level: "warn" }];
      return [{ kind: "login_url", url }];
    }
    return [{ kind: "notice", text: `account/login/start: unexpected reply type ${type || "(none)"}`, level: "warn" }];
  }
  notification(method: string, p: Json): AgentEvent[] {
    if (method === "account/login/completed") {
      const loginId = str(p.loginId);
      if (loginId && this.canceledIds.has(loginId)) return [];
      return p.success === true ? this.loggedIn() : this.failed(str(p.error) || "the login did not complete");
    }
    // account/updated: a login from elsewhere (another client on this home) also clears the state,
    // and a logout (authMode null) sets it as account/read's no-account answer does
    if (typeof p.authMode === "string") return this.loggedIn();
    if (method === "account/updated" && p.authMode === null) return this.read({ account: null, requiresOpenaiAuth: true });
    return [{ kind: "notice", text: method, level: "info", quiet: true }];
  }
  /** the failure in the server's words, the key (if one was in flight) masked out */
  failed(why: string): AgentEvent[] {
    const text = this.mask(why);
    this.key = null;
    this.open = false;
    return [{ kind: "notice", text: `Codex login failed: ${text}`, level: "error" }];
  }
  private loggedIn(): AgentEvent[] {
    this.key = null;
    this.open = false;
    this.loggedOut = false;
    return [{ kind: "auth", loggedIn: true }];
  }
}
