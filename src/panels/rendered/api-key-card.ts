// Codex login of a logged-out Rendered tab: one card at the end of the transcript, on the Permission
// card's frame (cards.ts approvalCard: head, the one-row strip of the Notes field and the decision
// pair), no new look. It offers ChatGPT and API Key (both the green decision button), turns
// into the masked key entry in place, shows a spinner while a ChatGPT login waits on the browser, keeps
// a failure in the card, and folds to one "Logged In" row once the account state flips. The key lives
// only in the field until Log In; Log In and Cancel empty it and the view is rebuilt without it, so no
// folded record holds it. `blk-login` keeps the card out of drive()'s pending-card snapshot, which reads
// permission and question cards only. The status-bar pill and its menu stay as they were and drive the
// same card.

import type { AgentAdapter, LoginMethod } from "../../agents/protocol";
import { DRIVE_CLASS } from "../rendered-drive";
import { iconImg } from "../../icon-img";
import { btn, el } from "./dom";
import { cardShell } from "./card-shell";
import { svgEl } from "./icons";
import { markSlot } from "./marks";
import { copyButton } from "../file-actions";
import { copyText } from "../../clipboard";

/** A Codex tab logs in through its own app-server (agents/codex.ts encodeLogin): the pill opens the choice. */
export const CODEX_LOGIN_TIP = "Codex is not logged in. Click Not Logged In in the status bar to log in with ChatGPT or an API key.";

export const API_KEY_CARD = "blk-login";
export const LOGIN_TITLE = "Log In To Codex";
export const LOGIN_PENDING = "Waiting For Browser";
export const LOGIN_DONE = "Logged In";
/** the pending view's copy action for the ChatGPT login link (the Copy button's tooltip) */
export const LOGIN_COPY_LINK = "Copy Link";
/** what agents/codex-login.ts failed() text starts with: rendered.ts routes such a notice into the card */
export const LOGIN_FAILED_PREFIX = "Codex login failed";

/** The key entry row: the masked field, Log In (the Allow button) and Cancel (the neutral Deny one).
 *  `submit` gets the trimmed key, `cancel` runs on Cancel or Escape; the field is emptied before either. */
function keyRow(actions: HTMLElement, submit: (key: string) => void, cancel: () => void): HTMLInputElement {
  const field = el("input", DRIVE_CLASS.message);
  field.type = "password";
  field.autocomplete = "off";
  field.spellcheck = false;
  field.setAttribute("aria-label", "OpenAI API Key");
  const logIn = btn("Log In", DRIVE_CLASS.allow, () => {
    const key = field.value.trim();
    if (!key) return;
    field.value = "";
    submit(key);
  });
  logIn.disabled = true;
  const no = btn("Cancel", DRIVE_CLASS.deny, () => { field.value = ""; cancel(); });
  field.addEventListener("input", () => { logIn.disabled = field.value.trim() === ""; });
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); logIn.click(); }
    else if (e.key === "Escape") { e.preventDefault(); no.click(); }
  });
  actions.append(field, logIn, no);
  return field;
}

function shieldHead(shell: ReturnType<typeof cardShell>, title: string): void {
  const icon = iconImg("shield");
  icon.title = title;
  shell.head!.prepend(icon);
}

/** The key entry alone, as its own card (Log In or Cancel removes it). */
export function apiKeyCard(onSubmit: (key: string) => void, onClose: () => void): { card: HTMLElement; field: HTMLInputElement } {
  const shell = cardShell({
    root: "div",
    classes: `blk ${DRIVE_CLASS.card} ${API_KEY_CARD}`,
    parts: ["head", "title", "actions"],
    title: "OpenAI API Key",
    partClasses: { head: "approval-head", title: "approval-title", actions: "approval-actions" },
  });
  const card = shell.root;
  shieldHead(shell, "OpenAI API Key");
  let closed = false;
  const close = (key: string | null) => {
    if (closed) return;
    closed = true;
    card.remove();
    if (key) onSubmit(key);
    onClose();
  };
  const field = keyRow(shell.actions!, (key) => close(key), () => close(null));
  return { card, field };
}

export type LoginView = "choice" | "key" | "pending" | "done";

export interface LoginCard {
  card: HTMLElement;
  view: () => LoginView;
  /** the key field while the key entry is up */
  field: () => HTMLInputElement | null;
  /** the two buttons again; a failure's text, if given, sits above them */
  choice: (failure?: string) => void;
  key: () => void;
  /** a ChatGPT login is out: spinner, "Waiting For Browser", and Cancel; once its link is known, a
   *  Copy Link action too, so a browser that never opened still leaves the link reachable */
  pending: (url?: string) => void;
  /** the account state flipped to logged in: one row */
  fold: () => void;
  /** a card dropped by /clear or a respawn: its detached field keeps no typed key */
  drop: () => void;
}

export interface LoginCardHandlers {
  chatgpt: () => void;
  apiKey: (key: string) => void;
  cancel: () => void;
}

/** Another agent's login on the same card (claude-login.ts): its title and the choice row's buttons. */
export interface LoginCardLook {
  title: string;
  choices: (api: LoginCard) => HTMLElement[];
}

export function loginCard(on: LoginCardHandlers, look?: LoginCardLook): LoginCard {
  const title = look?.title ?? LOGIN_TITLE;
  const shell = cardShell({
    root: "div",
    classes: `blk ${DRIVE_CLASS.card} ${API_KEY_CARD}`,
    parts: ["head", "title"],
    title,
    partClasses: { head: "approval-head", title: "approval-title" },
  });
  const card = shell.root;
  const head = shell.head!;
  shieldHead(shell, title);
  let view: LoginView = "choice";
  let field: HTMLInputElement | null = null;
  const clear = () => {
    if (field) field.value = "";
    field = null;
    while (head.nextSibling) head.nextSibling.remove();
  };
  const actions = () => { const a = el("div", "approval-actions"); card.append(a); return a; };
  const choiceRow = () => {
    const a = actions();
    if (look) { a.append(...look.choices(api)); return; }
    a.append(btn("ChatGPT", DRIVE_CLASS.allow, () => on.chatgpt()), btn("API Key", DRIVE_CLASS.allow, () => api.key()));
  };
  const api: LoginCard = {
    card,
    view: () => view,
    field: () => field,
    choice(failure) {
      if (view === "done") return;
      clear();
      view = "choice";
      if (failure) { const w = el("div", "approval-why failed", failure); w.title = failure; card.append(w); }
      choiceRow();
    },
    key() {
      if (view === "done") return;
      clear();
      view = "key";
      field = keyRow(actions(), (k) => { on.apiKey(k); }, () => { api.choice(); card.querySelector<HTMLButtonElement>("button:last-child")?.focus(); });
      field.focus();
    },
    pending(url) {
      if (view === "done") return;
      clear();
      view = "pending";
      const row = actions();
      row.append(markSlot("running"), el("span", "approval-why", LOGIN_PENDING));
      if (url) row.append(copyButton({ title: LOGIN_COPY_LINK, copy: () => copyText(url) }));
      row.append(btn("Cancel", DRIVE_CLASS.deny, () => { on.cancel(); api.choice(); }));
    },
    fold() {
      if (view === "done") return;
      clear();
      view = "done";
      card.classList.add(DRIVE_CLASS.settled);
      shell.title!.textContent = LOGIN_DONE;
      const glyph = el("span", `${DRIVE_CLASS.result} ok`);
      glyph.title = LOGIN_DONE;
      glyph.appendChild(svgEl("check", LOGIN_DONE));
      head.appendChild(glyph);
    },
    drop() {
      clear();
    },
  };
  api.choice();
  return api;
}

export interface CodexLoginDeps {
  sendEncoded: (line: string | null) => Promise<boolean>;
  /** puts the card at the end of the transcript (rendered.ts: seal the open group, append) */
  mount: (card: HTMLElement) => void;
  textarea: HTMLTextAreaElement;
  noticeBlock: (text: string, level: "info" | "warn" | "error") => void;
}

/** A Log In pressed after the process ended (the card stays up through an exit): it names the exit
 *  line's button (lifecycle.ts onExit), Resume when the tab has a session to resume, else Restart. A
 *  typed /clear cannot restart it: the composer refuses every submit while the process is gone. */
export const codexDeadLogin = (resume: boolean): string => `Codex is not running. Press ${resume ? "Resume" : "Restart"}, then log in.`;
/** A Log In pressed before the session's initialize reply landed (a respawn keeps the card up). */
export const CODEX_LOGIN_STARTING = "Codex is still starting. Log in once it is ready.";

/** The tab's two logins (the login card and the status-bar pill's menu) for an adapter that logs in itself;
 *  one card at a time. `ready`: the logins go out only once the session's initialize reply has landed (a
 *  press before that went to a not-yet-attached or not-initialized process). `offer` mounts the card when
 *  the tab is logged out (status-bar redraw), `settle` folds it once the account state says logged in. */
export function codexLogin(S: { adapter: AgentAdapter; isAlive: boolean; sessionId?: string | null }, deps: CodexLoginDeps): {
  chatgpt: () => void; apiKey: () => void; ready: () => boolean; offer: () => void; settle: () => void; fail: (text: string) => boolean;
  url: (url: string) => void;
} {
  let current: LoginCard | null = null;
  let mounting = false;
  /** the card still asking; a folded one is history and a later logout gets a new card */
  const live = () => (current?.card.isConnected && current.view() !== "done" ? current : null);
  const dead = () => deps.noticeBlock(codexDeadLogin(!!S.sessionId), "warn");
  const send = (c: LoginCard, method: LoginMethod) => {
    if (!S.adapter.encodeLogin) return;
    if (!S.isAlive) { dead(); c.choice(); return; }
    // a respawned process keeps the card up before its initialize reply: a login now is refused
    if (S.adapter.loginReady?.() === false) { deps.noticeBlock(CODEX_LOGIN_STARTING, "warn"); c.choice(); return; }
    if (c.view() === "pending") cancel(); // a new login replaces the one out; its server lets go of the port
    if (method === "chatgpt") c.pending(); else c.choice();
    void deps.sendEncoded(S.adapter.encodeLogin(method)).then((ok) => { if (!ok) c.choice(); });
  };
  const cancel = () => {
    const adapter = S.adapter as AgentAdapter & { encodeLoginCancel?: () => string | null };
    if (!S.isAlive) { dead(); return; }
    if (adapter.encodeLoginCancel) void deps.sendEncoded(adapter.encodeLoginCancel());
  };
  const ensure = (): LoginCard => {
    const have = live() ?? (mounting ? current : null);
    if (have) return have;
    current?.drop();
    const c: LoginCard = loginCard({
      chatgpt: () => send(c, "chatgpt"),
      apiKey: (apiKey) => send(c, { apiKey }),
      cancel,
    });
    current = c;
    mounting = true; // a redraw the mount triggers must not offer a second card
    try { deps.mount(c.card); } finally { mounting = false; }
    // the card replaces the warn tip the flip just drew (login.ts), which sits right above it
    const prev = c.card.previousElementSibling;
    if (prev?.classList.contains("blk-notice") && prev.textContent === CODEX_LOGIN_TIP) prev.remove();
    return c;
  };
  return {
    ready: () => S.isAlive && S.adapter.loginReady?.() !== false,
    offer: () => { if (S.adapter.encodeLogin) ensure(); },
    settle: () => { live()?.fold(); },
    /** A failed() notice ("Codex login failed: ..."): true when an open card took the text, so the body
     *  draws no second copy of it in the transcript. */
    fail: (text) => {
      const c = live();
      if (!c || !text.startsWith(LOGIN_FAILED_PREFIX)) return false;
      c.choice(text);
      return true;
    },
    /** the ChatGPT login's link: the pending card offers it as Copy Link (events.ts login_url) */
    url: (url) => { const c = live(); if (c?.view() === "pending") c.pending(url); },
    chatgpt: () => send(ensure(), "chatgpt"),
    apiKey: () => {
      const c = ensure();
      if (c.view() === "key") { c.field()?.focus(); return; }
      if (c.view() === "pending") cancel(); // the key entry replaces a ChatGPT login still out
      c.key();
    },
  };
}
