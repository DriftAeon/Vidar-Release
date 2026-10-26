// Bare warning notices with actions: a Codex trust card (Trust Folder, Dismiss) first, then one
// Ask-only card per other warning (Ask Agent to Fix). Dismiss removes its card from this view only:
// nothing is persisted, and the trust card never calls the fix seam. The trust write lives in Rust (bare/codex_trust.rs); this file
// is the one caller of `codex_trust_folder` and only passes the folder the card showed.

import { invoke } from "../../ipc";
import { lucide } from "../../icons";
import { el } from "./dom";
import { FIX_UNAVAILABLE, fixAvailable, requestFix } from "./fix-seam";
import type { AgentId } from "../../agents/id";

/** What `codex_trust_offer` returns for a tab whose launch folder the user's Codex config does not trust. */
export interface TrustOffer {
  folder: string;
  text: string;
}

/** What the cards close over in a Rendered body. */
export interface NoticeHost {
  tabId: string;
  agent: AgentId;
  /** the tab's launch folder */
  cwd: string;
  append: (node: HTMLElement) => void;
  sealGroup: () => void;
  /** open a fresh tab in the folder; `keepThis` leaves this tab open. Absent: the trust card has no Refresh. */
  reopenHere?: (keepThis: boolean) => Promise<void>;
  /** whether the chat already holds a user turn (Refresh then keeps this tab) */
  hasTurns?: () => boolean;
}

/** The trust card's Refresh seam (see NoticeHost). */
export interface TrustReopen {
  run: (keepThis: boolean) => Promise<void>;
  hasTurns: () => boolean;
}

export const TRUST_LABEL = "Trust Folder";
export const ASK_LABEL = "Ask Agent to Fix";
export const DISMISS_LABEL = "Dismiss";
export const TRUSTED_LINE = "Trusted. Reopen the tab to load project settings.";
export const TRUSTED_REFRESH_LINE = "Trusted. Refresh to load the project settings.";
export const REFRESH_LABEL = "Refresh";
export const REFRESH_KEEPS_CHAT = "Opens a fresh tab here; this chat stays open.";
const REFRESH_FALLBACK = "Couldn't refresh: reopen the tab yourself";
const TRUST_FALLBACK = "Couldn't trust this folder: reopen the tab and try again";
const ASK_FALLBACK = "Couldn't open a Claude tab to fix this";

/** An action button on the Sheen face: default, loading (aria-busy, spinner, `busyLabel`) and error
 *  (red edge, the card's error line; still clickable, so a click retries). */
export function actionButton(label: string, busyLabel: string, primary: boolean, run: () => Promise<void>, onError: (message: string | null) => void, fallback: string): HTMLButtonElement {
  const b = el("button", primary ? "wb-card-btn wb-card-btn-primary notice-trust" : "wb-card-btn", label);
  b.type = "button";
  b.addEventListener("click", () => {
    if (b.getAttribute("aria-busy") === "true") return;
    b.classList.remove("is-error");
    onError(null);
    b.setAttribute("aria-busy", "true");
    b.replaceChildren(lucide("loader-circle", "icn notice-spin"), document.createTextNode(busyLabel));
    run().then(
      () => { b.removeAttribute("aria-busy"); b.textContent = label; },
      (e) => {
        b.removeAttribute("aria-busy");
        b.textContent = label;
        b.classList.add("is-error");
        const raw = e instanceof Error ? e.message : String(e);
        onError(raw.startsWith("Couldn't ") ? raw : fallback);
      },
    );
  });
  return b;
}

export function card(text: string): { root: HTMLElement; acts: HTMLElement; text: HTMLElement; error: (message: string | null) => void } {
  const root = el("div", "blk blk-notice-card");
  const body = el("div", "notice-body");
  const textEl = el("div", "blk-notice warn", text);
  body.appendChild(textEl);
  const line = el("div", "notice-err");
  line.hidden = true;
  body.appendChild(line);
  const acts = el("div", "wb-actions notice-acts");
  root.append(body, acts);
  const error = (message: string | null) => {
    line.hidden = message === null;
    line.textContent = message ?? "";
  };
  return { root, acts, text: textEl, error };
}

/** Plain Sheen text button: removes its card from the view. No busy or error state, nothing persisted. */
function dismissButton(card: HTMLElement): HTMLButtonElement {
  const b = el("button", "wb-card-btn", DISMISS_LABEL);
  b.type = "button";
  b.addEventListener("click", () => card.remove());
  return b;
}

function askButton(host: NoticeHost, warning: string, folder: string, error: (message: string | null) => void): HTMLButtonElement {
  const b = actionButton(
    ASK_LABEL,
    "Opening",
    false,
    () => requestFix({ agentLabel: host.agent === "codex" ? "Codex" : "Claude", folder, warning }),
    error,
    ASK_FALLBACK,
  );
  if (!fixAvailable()) {
    b.disabled = true;
    b.title = FIX_UNAVAILABLE;
  }
  return b;
}

/** The trust card: Trust Folder (busy, error, then the Trusted line) and Dismiss. The chat notice area and
 *  the Runes trace both draw it, so there is one renderer; the write happens only on the click. */
export function trustCard(tabId: string, trust: TrustOffer, reopen?: TrustReopen): HTMLElement {
  const c = card(trust.text);
  const trustBtn = actionButton(
    TRUST_LABEL,
    "Trusting",
    true,
    async () => {
      await invoke("codex_trust_folder", { id: tabId, folder: trust.folder });
      if (!reopen) {
        const done = el("div", "blk blk-notice done");
        done.append(lucide("check", "icn"), document.createTextNode(TRUSTED_LINE));
        c.root.replaceWith(done);
        return;
      }
      // the card stays: its text and its one button change, so the next step is where the eye is
      c.text.textContent = TRUSTED_REFRESH_LINE;
      c.error(null);
      const refresh = actionButton(
        REFRESH_LABEL,
        "Refreshing",
        true,
        () => reopen.run(reopen.hasTurns()),
        c.error,
        REFRESH_FALLBACK,
      );
      const title = () => { refresh.title = reopen.hasTurns() ? REFRESH_KEEPS_CHAT : ""; };
      title();
      refresh.addEventListener("pointerenter", title);
      c.acts.replaceChildren(refresh);
    },
    c.error,
    TRUST_FALLBACK,
  );
  c.acts.append(trustBtn, dismissButton(c.root));
  return c.root;
}

export const VIDAR_CARD_TEXT = "Codex can't run in Vidar's Folder";
export const WORKTREE_LABEL = "Open in Worktree";
export const WORKTREE_TITLE = "Makes a git worktree of Vidar at HEAD under runtime\\worktrees and opens Codex there; uncommitted changes stay here.";
const WORKTREE_FAILED = "Couldn't open a worktree: ";

/** The refused-Vidar-folder card: Open in Worktree (busy, error line) and Dismiss. Same card and button
 *  builders as the trust card; `open` makes the worktree and opens the replacement tab. */
export function vidarFolderCard(open: () => Promise<void>): HTMLElement {
  const c = card(VIDAR_CARD_TEXT);
  const b = actionButton(
    WORKTREE_LABEL,
    "Opening",
    true,
    () => open().catch((e) => { throw new Error(WORKTREE_FAILED + (e instanceof Error ? e.message : String(e))); }),
    c.error,
    WORKTREE_FAILED + "try again",
  );
  b.title = WORKTREE_TITLE;
  c.acts.append(b, dismissButton(c.root));
  return c.root;
}

/** Draws the warnings a Bare spawn reported: the trust card (when the folder is untrusted), then one
 *  card per warning. */
export function bareNotices(host: NoticeHost, warnings: readonly string[], trust: TrustOffer | null): void {
  if (!trust && warnings.length === 0) return;
  host.sealGroup();
  if (trust) {
    const { reopenHere, hasTurns } = host;
    host.append(trustCard(host.tabId, trust, reopenHere ? { run: reopenHere, hasTurns: hasTurns ?? (() => false) } : undefined));
  }
  for (const w of warnings) {
    const c = card(w);
    c.acts.appendChild(askButton(host, w, host.cwd, c.error));
    host.append(c.root);
  }
}
