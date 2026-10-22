// The ask gate: a modal that puts a tab's request in front of the user with
// Approve / Deny and an optional comment. Rust half is src-tauri/src/open.rs.
//
// Deliberately not the Display gate: that one rules on
// BYTES that landed in a folder and records its verdict in a sidecar next to
// them. This one rules on an ASK, has nothing to render, and must be answered
// while the asker is blocked — so it is a modal, not a workbench tab that the
// user might not be looking at.
//
// Nothing in `details` or `question` is ever parsed or executed; both are set as
// textContent. Rust has already allowlisted them to one line of printable ASCII.
import { iconImg } from "../icon-img";
import { splitRecommended } from "./rendered/ask-answers";
import { ASK_KINDS, DEFAULT_ASK_PLACEHOLDER } from "./askgate-kinds";
import { renderNodeMatrix, type NodeMatrix } from "../control/node-matrix";

function askTitle(req: AskRequest, kind: string | undefined): string {
  return (kind ? ASK_KINDS[kind]?.title : undefined) ?? req.title ?? "";
}

export interface AskRequest {
  /** only for an ask whose kind is not in ASK_KINDS (the "Question" ask); a registered kind's title wins */
  title?: string;
  /** label -> value rows, shown in order above the question */
  details: [string, string][];
  /** the Node Matrix layout of the same facts; when set it replaces the label/value rows in the modal
   *  (`details` still feeds the drive surface's `state.cards`) */
  matrix?: NodeMatrix;
  question: string;
  /** offered as one-click picks above the comment box; picking one does not
   *  submit by itself — Approve still does, so a pick can be reconsidered. */
  choices?: string[];
  /** `choiceDetails[i]` describes `choices[i]`; shown as the button's tooltip (the modal's
   *  buttons are read by textContent, so the description stays out of the text) */
  choiceDetails?: string[];
  /** placeholder for the comment box; the comment is free text either way */
  placeholder?: string;
  /** now_ms when Rust claimed the request — the expiry clock starts there, not
   *  when this reached the queue, so a long wait behind another dialog counts. */
  claimedAtMs?: number;
  /** the ask's own id, used as its entry id in the drive surface's `state.cards` */
  id?: string;
  /** absolute deadline (epoch ms) that replaces `claimedAtMs + EXPIRE_MS` in this ask's
   *  pre-render staleness check. The three `ctl.*` callers (listen.ts) pass the card's
   *  Rust-stamped `expiresAtMs` (card.rs) so this check and their on-screen expiry
   *  timer agree on the same deadline. */
  expiresAtMs?: number;
  /** the tab the ask concerns, when there is one (a `ctl.prompt` target, an
   *  asker's own tab); drive's `state.cards` shows it, nothing else reads it. */
  tab?: string;
  /** extra class on the modal, so a card can scope its own CSS without touching the others */
  variant?: string;
  /** true when the card asks permission to act (not a question): the head leads with the shield icon */
  permission?: boolean;
}

/** One in-flight ask as the drive surface sees it (`state.cards`):
 *  smokes had no way to find a gate card short of reading the DOM. */
export interface PendingAsk {
  id: string;
  kind: string | null;
  title: string;
  tab: string | null;
  details: Record<string, string>;
  /** rendered now; the rest wait behind it in the queue */
  onScreen: boolean;
}

/** `shown` is the third state: the ask was answered by this module without the
 *  user seeing it (deduped or expired), which is NOT a denial. `src/control/open-ask.ts` must not
 *  record it as one — that is the confusion `verdict` exists to prevent. */
export interface AskAnswer {
  approved: boolean;
  shown: boolean;
  comment: string;
  /** the picked `choices` entry, if any were offered and one was picked */
  choice?: string | null;
  /** set only when shown === false: why it self-answered */
  reason?: string;
}

// A queued ask older than this never reaches the screen. It has to be well
// inside the requester's own deadline (the requester
// starts its clock BEFORE Rust's 2 s poller claims the file), or the caller
// times out to `unknown` first and the verdict is written where nobody reads
// it — and the role forbids re-asking on unknown.
const EXPIRE_MS = 120_000;

let backdrop: HTMLElement | null = null;
let modal: HTMLElement | null = null;
let onScreen = false;
let restoreFocusTo: HTMLElement | null = null;
// One dialog at a time: a second ask waits behind the first rather than
// stacking two the user has to guess the order of.
let queue: Promise<unknown> = Promise.resolve();
// Kinds with an ask IN FLIGHT — queued or on screen. Depth is the wrong bound
// for this bridge: only one Astra may be armed, so three approved dialogs would
// still yield one tab and two "already armed" failures. One ask per kind at a
// time is the bound that matches the scarce resource.
//
// In flight, not "satisfied": holding the kind after a successful spawn would
// mean that closing the Astra tab leaves the requester unable to ask for another one
// for the rest of the session, with no way to clear it. A duplicate ask later
// is caught by spawnAstra's own armed check, which fails with a reason the user
// can read — a wasted click beats a silent lockout.
const inFlightKinds = new Set<string>();
// The kind currently on screen (rendered, not just queued) — cancelAsk uses
// this to know whether it needs to tear down a live modal or just resolve a
// still-queued one. At most one kind can be on screen at a time.
let onScreenKind: string | null = null;
// Resolves the in-flight ask for a kind, queued or on screen. Populated by
// askGate right as it enters the queue, cleared once that ask settles.
const pendingResolvers = new Map<string, (a: AskAnswer) => void>();
// Set by render() while its modal is up: dismisses it (DOM + bookkeeping)
// and resolves with a caller-supplied AskAnswer, same path Deny/Esc use.
let currentDismiss: ((ans: AskAnswer) => void) | null = null;
// Every ask from enqueue to settle, in queue order (Map keeps insertion order).
const pendingAsksById = new Map<string, PendingAsk>();
let askSeq = 0;

/** In-flight asks, queue order; the first with onScreen is the modal up now. */
export function pendingAsks(): PendingAsk[] {
  return [...pendingAsksById.values()].map((a) => ({ ...a, details: { ...a.details } }));
}

/** shortcuts.ts asks this before running any chord: it registers its capture
 *  listener at init, so it sees keys FIRST and would otherwise cycle tabs out
 *  from under an open dialog. */
export function isAskModalOpen(): boolean {
  return onScreen;
}


function build() {
  if (modal) return;
  backdrop = document.createElement("div");
  backdrop.id = "ask-backdrop";
  backdrop.className = "hidden";
  document.body.appendChild(backdrop);
  modal = document.createElement("div");
  modal.id = "ask-modal";
  modal.className = "hidden";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "ask-title");
  document.body.appendChild(modal);
}

function render(req: AskRequest, kind: string | undefined, done: (a: AskAnswer) => void) {
  build();
  const m = modal!;
  m.replaceChildren();
  m.className = req.variant ? `hidden ${req.variant}` : "hidden"; // the previous card's variant must not stick

  const head = document.createElement("div");
  head.className = "ask-head";
  head.id = "ask-title";
  // every gate head is the title bar strip with its icon in a tile (title-bar.css): the shield on a
  // permission ask (questions no longer reach the gate; they live in Relay)
  const icon = req.permission ? iconImg("shield") : null;
  if (icon) {
    const tile = document.createElement("span");
    tile.className = "title-tile";
    tile.appendChild(icon);
    head.appendChild(tile);
  }
  head.append(askTitle(req, kind));
  m.appendChild(head);

  const body = document.createElement("div");
  body.className = "ask-body";
  if (req.matrix) body.appendChild(renderNodeMatrix(req.matrix));
  else for (const [label, value] of req.details) {
    const row = document.createElement("div");
    row.className = "ask-row";
    const l = document.createElement("span");
    l.className = "ask-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "ask-value";
    v.textContent = value;
    row.append(l, v);
    body.appendChild(row);
  }
  const q = document.createElement("div");
  q.className = "ask-question";
  q.textContent = req.question;
  body.appendChild(q);

  // One-click picks (`ctl.ask --choice`). Picking sets `selectedChoice` but
  // does not submit — Approve still does, same as the comment box, so a pick
  // can be reconsidered before it goes anywhere.
  let selectedChoice: string | null = null;
  const choiceButtons: HTMLButtonElement[] = [];
  if (req.choices && req.choices.length > 0) {
    const choiceRow = document.createElement("div");
    choiceRow.className = "ask-choices";
    choiceRow.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px;";
    for (const [i, c] of req.choices.entries()) {
      const btn = document.createElement("button");
      btn.type = "button";
      const tip = req.choiceDetails?.[i];
      if (tip) btn.title = tip;
      btn.className = "ask-btn ask-choice";
      // "(Recommended)" drawn as the trailing star, as the Rendered question form does; the answer keeps `c`
      const { shown, starred } = splitRecommended(c);
      btn.textContent = shown;
      if (starred) {
        const star = iconImg("star");
        star.title = "Recommended";
        btn.append(star);
      }
      btn.addEventListener("click", () => {
        selectedChoice = c;
        for (const b of choiceButtons) b.style.fontWeight = b === btn ? "700" : "400";
      });
      choiceButtons.push(btn);
      choiceRow.appendChild(btn);
    }
    body.appendChild(choiceRow);
  }

  const comment = document.createElement("input");
  comment.className = "ask-comment";
  comment.type = "text";
  comment.placeholder = req.placeholder ?? (kind ? ASK_KINDS[kind]?.placeholder : undefined) ?? DEFAULT_ASK_PLACEHOLDER;
  body.appendChild(comment);

  m.appendChild(body);

  // Approve left, Deny right. Both carry their colour at
  // rest, so the focus ring in styles.css is the only focus signal.
  const foot = document.createElement("div");
  foot.className = "ask-foot";
  const approve = document.createElement("button");
  approve.className = "ask-btn ask-approve";
  approve.textContent = "Approve";
  const deny = document.createElement("button");
  deny.className = "ask-btn ask-deny";
  deny.textContent = "Deny";
  foot.append(approve, deny);
  m.appendChild(foot);

  const focusables: HTMLElement[] = [...choiceButtons, comment, approve, deny];
  let settled = false;
  // Shared teardown for Approve/Deny/Esc and an external cancelAsk() — same
  // DOM cleanup and bookkeeping either way, only the AskAnswer differs.
  const settle = (ans: AskAnswer) => {
    if (settled) return;
    settled = true;
    onScreen = false;
    onScreenKind = null;
    currentDismiss = null;
    document.removeEventListener("keydown", onKey, true);
    m.classList.add("hidden");
    backdrop!.classList.add("hidden");
    // back to whatever had focus before the dialog stole it
    if (restoreFocusTo?.isConnected) restoreFocusTo.focus();
    restoreFocusTo = null;
    done(ans);
  };
  const answer = (approved: boolean) =>
    settle({ approved, shown: true, comment: comment.value.trim(), choice: approved ? selectedChoice : null });
  // Esc denies. There is no dismiss-without-answering: the asker is blocked on
  // a verdict, and a closed dialog that wrote nothing would hang it until its
  // own deadline. The backdrop swallows clicks for the same reason.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); answer(false); return; }
    if (e.key === "Enter" && document.activeElement === comment) { e.preventDefault(); answer(true); return; }
    if (e.key !== "Tab") return;
    // Contain Tab inside the three controls. shortcuts.ts still sees the event
    // first; isAskModalOpen() is what stops it acting on Ctrl+Tab.
    e.preventDefault();
    e.stopPropagation();
    const i = focusables.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? focusables.length - 1 : i - 1) : (i < 0 || i === focusables.length - 1 ? 0 : i + 1);
    focusables[next].focus();
  };
  document.addEventListener("keydown", onKey, true);
  deny.addEventListener("click", () => answer(false));
  approve.addEventListener("click", () => answer(true));

  restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  onScreen = true;
  onScreenKind = kind ?? null;
  currentDismiss = (ans: AskAnswer) => settle(ans);
  backdrop!.classList.remove("hidden");
  m.classList.remove("hidden");
  approve.focus({ focusVisible: false }); // Enter still lands on it; no keyboard ring until the user presses a key
}

/** Show one ask and resolve with the user's answer, or self-answer without
 *  showing it. Queued behind any other ask. */
export function askGate(req: AskRequest, kind?: string): Promise<AskAnswer> {
  if (kind) {
    if (inFlightKinds.has(kind)) {
      return Promise.resolve({ approved: false, shown: false, comment: "",
        reason: `an ask for "${kind}" is already on screen or queued; only one at a time is useful` });
    }
    inFlightKinds.add(kind);
  }
  const seq = ++askSeq;
  const entryId = req.id && !pendingAsksById.has(req.id) ? req.id : `gate-${seq}`; // Rust card ids are bare decimals; this prefix can't collide
  const entry: PendingAsk = {
    id: entryId, kind: kind ?? null, title: askTitle(req, kind), tab: req.tab ?? null,
    details: Object.fromEntries(req.details), onScreen: false,
  };
  pendingAsksById.set(entryId, entry);
  const shown = queue.then(() => new Promise<AskAnswer>((resolve) => {
    if (kind) pendingResolvers.set(kind, resolve);
    // Checked here, not at enqueue: the wait behind another dialog is exactly
    // the time that makes an ask stale.
    const now = Date.now();
    const age = req.claimedAtMs ? now - req.claimedAtMs : 0;
    const expired = req.expiresAtMs !== undefined ? now > req.expiresAtMs : age > EXPIRE_MS;
    if (expired) {
      resolve({ approved: false, shown: false, comment: "",
        reason: `expired after ${Math.round(age / 1000)}s waiting behind another dialog; it was never shown` });
      return;
    }
    entry.onScreen = true;
    render(req, kind, resolve);
  })).finally(() => {
    pendingAsksById.delete(entryId);
    if (kind) { inFlightKinds.delete(kind); pendingResolvers.delete(kind); }
  });
  // the queue must not break on a rejection upstream
  queue = shown.catch(() => undefined);
  return shown;
}

/** Answers the in-flight ask of `kind` — queued or on screen — as the user would have, from a
 *  second surface (Relay's Run Flow item). Same resolve-and-teardown path as `cancelAsk`, with
 *  `shown: true` so the caller records a real verdict. Returns false if `kind` has no in-flight
 *  ask (the modal answered first, or it expired). */
export function answerAsk(kind: string, answer: { approved: boolean; comment?: string }): boolean {
  const resolve = pendingResolvers.get(kind);
  if (!resolve) return false;
  pendingResolvers.delete(kind);
  const ans: AskAnswer = { approved: answer.approved, shown: true, comment: answer.comment ?? "" };
  if (onScreenKind === kind && currentDismiss) currentDismiss(ans);
  else resolve(ans);
  return true;
}

/** Resolves the in-flight ask of `kind` — queued or on screen — with a
 *  denial that carries `reason`, tearing down its modal if one is rendered.
 *  Used by listen.ts's own expiry timer (runs to the card's `expiresAtMs`): a rendered
 *  card only sweeps server-side when another Act verb's card arrives, so a
 *  lone card needs this to expire on its own. Returns false if `kind` has
 *  no in-flight ask (already answered/expired). */
export function cancelAsk(kind: string, reason: string): boolean {
  const resolve = pendingResolvers.get(kind);
  if (!resolve) return false;
  pendingResolvers.delete(kind);
  const ans: AskAnswer = { approved: false, shown: true, comment: "", reason };
  if (onScreenKind === kind && currentDismiss) currentDismiss(ans);
  else resolve(ans);
  return true;
}
