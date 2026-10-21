// Relay form for a pending ask, on its card and in Open Large: the question, one button per choice
// (a click selects it; nothing is sent), an optional comment, and Answer (sends the picked choice
// and the typed comment), Dismiss and Copy Answer (once the session has ended); the row reads state,
// Copy Answer, Answer, Dismiss, right-aligned. Tab state (ready / not
// ready / not open / ended) comes from source-asks; one 5 s readiness poll serves every live form
// while the workbench Relay tab is on screen. Open Large's form polls only then too: acceptable,
// because sendAnswer re-checks the tab before it delivers anything.

import { copyText } from "../clipboard";
import { askLabel } from "../panels/rendered/ask-answers";
import { btn, el } from "../panels/rendered/dom";
import { answerText, askErrorText, askTabState, type AskTabState } from "./source-asks";
import type { RelayItem } from "./store";

const POLL_MS = 5000;
const STATE_TEXT: Record<AskTabState, string> = {
  ready: "",
  "not-ready": "Tab Not Ready",
  "no-tab": "Tab Not Open",
  ended: "Session Ended",
};

export interface AskForm {
  /** the row holding the state line, Copy Answer, Answer and Dismiss */
  actions: HTMLElement;
  refreshTab(): Promise<void>;
  dispose(): void;
}

export interface AskFormOpts {
  /** a send failure or copy result; absent, the form's own state line shows it */
  onNote?(msg: string): void;
  /** the card's form: a one-line comment */
  compact?: boolean;
}

const forms = new Set<AskForm>();
let visible = false;
let timer: ReturnType<typeof setInterval> | null = null;

function syncPoll(): void {
  const want = visible && forms.size > 0;
  if (want && timer === null) {
    timer = setInterval(() => { for (const f of [...forms]) void f.refreshTab(); }, POLL_MS);
  } else if (!want && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Relay is on screen (true) or not; the poll follows it. */
export function setAskVisible(on: boolean): void {
  visible = on;
  if (on) for (const f of [...forms]) void f.refreshTab();
  syncPoll();
}

/** Builds the form for `item` into `host` (replacing its children); null unless item.view is an ask. */
export function createAskForm(host: HTMLElement, item: RelayItem, opts: AskFormOpts = {}): AskForm | null {
  if (item.view.type !== "ask") return null;
  const ask = item.view.ask;
  let tabState: AskTabState = "no-tab";
  let tabTitle = "";
  let sending = false;
  let tabSeq = 0;
  let disposed = false;
  let note = "";
  let picked: string | null = null;

  const form = el("div", "blk-question relay-ask-form");
  const forEl = el("div", "relay-ask-for");
  const q = el("div", "q");
  const text = el("div", "q-text", ask.question);
  const options = el("div", "q-options");
  options.setAttribute("role", "radiogroup");
  const comment = el("textarea", "q-other relay-ask-comment");
  comment.rows = opts.compact ? 1 : 3;
  comment.maxLength = 4000;
  comment.placeholder = ask.choices.length > 0 ? "Comment" : "Answer";
  const actions = el("div", "relay-ask-actions");
  const sendBtn = btn("Answer", "relay-ask-send relay-approve", () => void send(picked));
  // neutral, like the display strip's Dismiss: the decision pair is reserved for Approve/Deny
  const dismissBtn = btn("Dismiss", "relay-ask-dismiss relay-dismiss", () => void run(() => item.resolve({ verdict: "deny", comment: "" })));
  const copyBtn = btn("Copy Answer", "relay-ask-copy", () => {
    void copyText(answerText(ask, picked, comment.value.trim())).then((ok) => say(ok ? "Copied" : "Copy Failed"));
  });
  const stateEl = el("span", "relay-ask-state dim");
  actions.append(stateEl, copyBtn, sendBtn, dismissBtn); // right-aligned, Dismiss at the far right

  for (const [i, label] of ask.choices.entries()) {
    const b = btn("", "q-opt", () => { if (sending) return; picked = label; sync(); });
    b.setAttribute("role", "radio");
    b.dataset.label = label;
    b.append(askLabel(label));
    // the description shares the button's text: readers of the picked label use dataset.label
    const detail = ask.details?.[i];
    if (detail) b.append(el("span", "q-desc", detail));
    options.appendChild(b);
  }
  comment.addEventListener("input", sync);
  q.append(text, options, comment);
  form.append(forEl, q, actions);
  host.replaceChildren(form);

  function say(msg: string): void {
    if (opts.onNote) { opts.onNote(msg); return; }
    note = msg;
    sync();
  }

  function sync(): void {
    if (disposed) return;
    const ended = tabState === "ended";
    const ready = tabState === "ready";
    const forText = ask.context || tabTitle;
    forEl.textContent = forText ? `For ${forText}` : "";
    forEl.classList.toggle("hidden", !forText);
    stateEl.textContent = note || STATE_TEXT[tabState];
    const typed = comment.value.trim() !== "";
    const hasAnswer = picked !== null || typed;
    sendBtn.classList.toggle("hidden", ended);
    copyBtn.classList.toggle("hidden", !ended);
    sendBtn.disabled = sending || !ready || !hasAnswer;
    dismissBtn.disabled = sending;
    copyBtn.disabled = sending || !hasAnswer;
    // a choice click only selects, so it is live except while an answer is being sent
    for (const c of options.children) {
      const b = c as HTMLButtonElement;
      const on = b.dataset.label === picked;
      b.disabled = sending;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    comment.disabled = sending;
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (sending) return;
    sending = true;
    note = "";
    sync();
    try {
      await action();
    } catch (e) {
      say(askErrorText(e));
    } finally {
      sending = false;
      sync();
    }
  }

  async function send(choice: string | null): Promise<void> {
    if (sending || tabState !== "ready") return;
    const body = comment.value.trim();
    await run(() => item.resolve({ verdict: "approve", comment: body, ...(choice !== null ? { choice } : {}) }));
  }

  async function refreshTab(): Promise<void> {
    const t = ++tabSeq;
    try {
      const r = await askTabState(ask.session);
      if (t !== tabSeq || disposed) return; // a newer read owns the form, or it has gone
      tabState = r.state;
      tabTitle = r.title;
    } catch {
      return;
    }
    sync();
  }

  const self: AskForm = {
    actions,
    refreshTab,
    dispose() {
      disposed = true;
      forms.delete(self);
      syncPoll();
    },
  };
  forms.add(self);
  sync();
  void refreshTab();
  syncPoll();
  return self;
}
