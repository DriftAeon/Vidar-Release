// Relay form for a question item, on its card and in Open Large: the chat's questionForm (every
// question, multi-select, Other), an optional note (record.notes), and Answer, Dismiss (record.dismiss)
// and, for a record answered by a user message (needsPrompt), Copy Answer once the session has ended;
// the row reads state, Copy Answer, Answer, Dismiss, right-aligned. A record that is not inline shows
// its questions and an Answer In Tab button instead. Tab state (ready / not ready / not open / ended)
// comes from source-asks and gates Answer only for needsPrompt; one 5 s readiness poll serves every
// live form while the workbench Relay tab is on screen. Open Large's form polls only then too:
// acceptable, because sendAnswer re-checks the tab before it delivers anything.

import type { AskReply, QuestionRecord } from "../asks/record";
import { pendReplyParts } from "../asks/record";
import { copyText } from "../clipboard";
import { btn, el } from "../panels/rendered/dom";
import { questionForm } from "../panels/rendered/question-form";
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
  /** the card's form: a one-line note */
  compact?: boolean;
  /** the card's title bar carries "For <tab>": given, the form's own line is hidden and the bar gets the name */
  onFor?(text: string): void;
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

/** the record as the Claude-shaped input `questionForm` reads; answers come back keyed by the record's ids */
function formInput(record: QuestionRecord): unknown {
  return {
    questions: record.questions.map((q) => ({
      id: q.id, question: q.text, options: q.options, multiSelect: q.multi, isOther: q.other, isSecret: q.secret,
    })),
  };
}

/** focuses the asker's tab (loaded on first use: the session layer reaches back into Relay) */
async function focusTab(id: string): Promise<void> {
  (await import("../panels/sessions")).activate(id);
}

/** Builds the form for `item` into `host` (replacing its children); null unless item.view is a question. */
export function createAskForm(host: HTMLElement, item: RelayItem, opts: AskFormOpts = {}): AskForm | null {
  if (item.view.type !== "question") return null;
  const { record, pend } = item.view;
  const session = pend?.session ?? record.askerSession;
  const gated = record.needsPrompt;
  let tabState: AskTabState = gated ? "no-tab" : "ready";
  let tabTitle = "";
  let sending = false;
  let tabSeq = 0;
  let disposed = false;
  let note = "";
  let answered = false;

  const form = el("div", "blk-question relay-ask-form");
  const forEl = el("div", "relay-ask-for");
  const q = el("div", "q");
  const actions = el("div", "relay-ask-actions");
  const stateEl = el("span", "relay-ask-state dim");
  const notesEl = el("textarea", "q-other relay-ask-comment");
  notesEl.rows = opts.compact ? 1 : 3;
  notesEl.maxLength = 4000;
  notesEl.placeholder = "Note";
  const sendBtn = btn("Answer", "relay-ask-send relay-approve", () => void send());
  // neutral, like the display strip's Dismiss: the decision pair is reserved for Approve/Deny
  const dismissBtn = btn("Dismiss", "relay-ask-dismiss relay-dismiss", () => void run(() => item.resolve({ verdict: "deny", comment: "" })));
  const copyBtn = btn("Copy Answer", "relay-ask-copy", () => {
    if (!pend) return;
    const { choice, comment } = pendReplyParts(record, reply());
    void copyText(answerText(pend, choice, comment)).then((ok) => say(ok ? "Copied" : "Copy Failed"));
  });
  const tabBtn = btn("Answer In Tab", "relay-ask-tab", () => { if (record.askerTab) void focusTab(record.askerTab); });
  tabBtn.disabled = !record.askerTab;

  let collect: () => unknown = () => ({ answers: {} });
  if (record.inline) {
    const f = questionForm(q, formInput(record), (ok) => { answered = ok; sync(); });
    collect = f.collect;
    if (record.notes) q.append(notesEl);
    actions.append(stateEl, copyBtn, sendBtn);
  } else {
    for (const it of record.questions) q.append(el("div", "q-text", it.text));
    actions.append(stateEl, tabBtn);
  }
  if (record.dismiss !== null) actions.append(dismissBtn); // right-aligned, Dismiss at the far right
  form.append(forEl, q, actions);
  host.replaceChildren(form);

  function reply(): AskReply {
    const answers = (collect() as { answers?: Record<string, string> }).answers ?? {};
    return { answers, notes: record.notes ? notesEl.value.trim() : "" };
  }

  function say(msg: string): void {
    if (opts.onNote) { opts.onNote(msg); return; }
    note = msg;
    sync();
  }

  function sync(): void {
    if (disposed) return;
    const ended = gated && tabState === "ended";
    const ready = !gated || tabState === "ready";
    const forText = record.context || tabTitle;
    forEl.textContent = forText ? `For ${forText}` : "";
    forEl.classList.toggle("hidden", !forText || !!opts.onFor);
    opts.onFor?.(forText ? `For ${forText}` : "");
    stateEl.textContent = note || (gated ? STATE_TEXT[tabState] : "");
    // the note alone is an answer where the record has one (a pend ask answered in words)
    const hasAnswer = answered || (record.notes && notesEl.value.trim() !== "");
    sendBtn.classList.toggle("hidden", ended);
    copyBtn.classList.toggle("hidden", !ended || !pend);
    sendBtn.disabled = sending || !ready || !hasAnswer;
    dismissBtn.disabled = sending;
    copyBtn.disabled = sending || !hasAnswer;
    q.toggleAttribute("inert", sending);
    notesEl.disabled = sending;
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

  async function send(): Promise<void> {
    if (sending || (gated && tabState !== "ready")) return;
    const r = reply();
    await run(() => item.resolve({ verdict: "approve", comment: r.notes, reply: r }));
  }

  async function refreshTab(): Promise<void> {
    if (!session) return;
    const t = ++tabSeq;
    try {
      const r = await askTabState(session);
      if (t !== tabSeq || disposed) return; // a newer read owns the form, or it has gone
      tabState = r.state;
      tabTitle = r.title;
    } catch {
      return;
    }
    sync();
  }

  notesEl.addEventListener("input", sync);
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
