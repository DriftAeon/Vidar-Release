// Relay questions drawn as cards in the asker's own tab: a pend or ctl-ask item whose askerTab is this
// tab also appears here as the Question card, with Relay's Comment field in the Other row's slot.
// Either side answers through the item's own resolve; the card leaves when the item does. These cards
// stay out of `approvals`, so they never hold the composer, Esc or the state chip.

import { DRIVE_CLASS } from "../rendered-drive";
import { items, subscribe, type RelayItem } from "../../relay/store";
import { ASK_FOCUS_EVENT, ASK_SETTLED_EVENT, pendReplyParts, type AskFocusDetail, type AskReply, type QuestionRecord } from "../../asks/record";
import { btn, el } from "./dom";
import { cardShell } from "./card-shell";
import { labelledMark } from "./marks";
import { questionForm } from "./question-form";

export interface TabAsksDeps {
  /** this body's tab id: only store items whose askerTab is this id are drawn */
  tabId: string;
  /** this tab's name, told to Relay with a chat-side answer */
  tabName: string | null;
  /** the transcript element the cards are appended to */
  host: HTMLElement;
  /** true while a restore replays history: draw nothing then */
  hydrating: () => boolean;
}

type QuestionItem = RelayItem & { view: { type: "question"; record: QuestionRecord } };

const isMine = (it: RelayItem, tabId: string): it is QuestionItem =>
  it.view.type === "question" && it.askerTab === tabId && (it.view.record.origin === "pend" || it.view.record.origin === "ctl-ask");

/** the first question as questionForm input (Claude shape: keyed by its text) */
function formInput(record: QuestionRecord): unknown {
  return { questions: record.questions.map((q) => ({ question: q.text, options: q.options, multiSelect: q.multi })) };
}

export function createTabAsks(deps: TabAsksDeps) {
  const { tabId, tabName, host, hydrating } = deps;
  const cards = new Map<string, HTMLElement>();
  let disposed = false;

  function drawCard(item: QuestionItem): HTMLElement {
    const { record } = item.view;
    const shell = cardShell({
      root: "div",
      classes: `blk ${DRIVE_CLASS.card} blk-question blk-tab-ask`,
      parts: ["head", "title", "body", "actions"],
      title: "Question",
      partClasses: { head: "approval-head", title: "approval-title", body: "approval-body", actions: "approval-actions" },
    });
    const card = shell.root, head = shell.head!, body = shell.body!, row = shell.actions!;
    card.dataset.tool = "AskUserQuestion";
    card.dataset.askKey = record.key;
    head.prepend(labelledMark("awaiting", "Question"));
    const comment = el("input", "q-other q-comment");
    comment.setAttribute("aria-label", "Comment");
    comment.setAttribute("placeholder", "Comment");
    const sync = () => { answer.disabled = busy || !(form.answered() || comment.value.trim() !== ""); };
    const form = questionForm(body, formInput(record), sync);
    // the form's own Other row is replaced: a pick and a comment travel together, as Relay's form sends them
    const slot = el("div", "q-other-row q-comment-row");
    slot.append(comment);
    const holder = body.querySelector(".q-options") ?? body;
    holder.querySelector(".q-other-row")?.remove();
    holder.appendChild(slot);
    comment.addEventListener("input", sync);
    const error = el("span", "approval-error");
    error.setAttribute("role", "alert");
    let busy = false;
    const reply = (): AskReply => {
      const { answers } = form.collect() as { answers: Record<string, string> };
      const item0 = record.questions[0];
      return { answers: item0 ? { [item0.id]: answers[item0.text] ?? "" } : {}, notes: comment.value.trim() };
    };
    const run = async (go: () => Promise<void>, done: () => void) => {
      if (busy) return;
      busy = true; error.textContent = ""; sync();
      try { await go(); done(); } catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
      busy = false; sync();
    };
    const answer = btn("Answer", DRIVE_CLASS.allow, () => {
      const r = reply();
      const { choice, comment: note } = pendReplyParts(record, r);
      void run(
        () => item.resolve({ verdict: "approve", comment: note, ...(choice ? { choice } : {}), reply: r }),
        () => window.dispatchEvent(new CustomEvent(ASK_SETTLED_EVENT, { detail: { key: record.key, where: tabName ?? tabId, answer: [choice, note].filter(Boolean).join(" · ") } })),
      );
    });
    const dismiss = btn(record.dismiss === "settle" ? "Dismiss" : "Deny", DRIVE_CLASS.deny, () => {
      void run(() => item.resolve({ verdict: "deny", comment: comment.value.trim() }), () => {});
    });
    answer.disabled = true;
    row.append(error, answer);
    if (record.dismiss) row.append(dismiss);
    return card;
  }

  /** sync the drawn cards with the store's items for this tab */
  function refresh(): void {
    if (disposed || hydrating()) return;
    const want = new Map<string, QuestionItem>();
    for (const it of items()) if (isMine(it, tabId)) want.set(it.view.record.key, it);
    for (const [key, card] of cards) {
      if (want.has(key) && card.isConnected) continue;
      card.remove();
      cards.delete(key);
    }
    for (const [key, it] of want) {
      if (cards.has(key)) continue;
      const card = drawCard(it);
      cards.set(key, card);
      host.appendChild(card);
    }
  }
  /** draw again from scratch (after hydration ends or a transcript reset wiped the cards) */
  function redraw(): void {
    for (const card of cards.values()) card.remove();
    cards.clear();
    refresh();
  }

  const unsubscribe = subscribe(refresh);
  const onFocus = (e: Event) => {
    const d = (e as CustomEvent<AskFocusDetail>).detail;
    if (!d || d.tabId !== tabId) return;
    const card = cards.get(d.key) ?? [...host.querySelectorAll<HTMLElement>("[data-ask-key]")].find((c) => c.dataset.askKey === d.key); // W2's card-backed cards carry the attribute too
    if (!card) return;
    card.scrollIntoView?.({ block: "nearest" });
    (card.querySelector<HTMLElement>(`.${DRIVE_CLASS.option}`) ?? card.querySelector<HTMLElement>("input, button"))?.focus();
  };
  window.addEventListener(ASK_FOCUS_EVENT, onFocus);
  refresh();

  /** the tab closed: its cards go with it */
  function dispose(): void {
    disposed = true;
    unsubscribe();
    window.removeEventListener(ASK_FOCUS_EVENT, onFocus);
    for (const card of cards.values()) card.remove();
    cards.clear();
  }
  return { refresh, redraw, dispose };
}
