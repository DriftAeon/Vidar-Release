// The body's card-backed questions as Relay items (kind "question"). Each body owns one slice of the
// shared "card-questions" source and re-derives it from cards.ts openQuestions() on every refresh, so an
// answer in chat, a turn end or a transcript reset drops the item on the next pass; dispose drops the slice.
// Relay answers through the handle, i.e. the card's own settle: one answer path, first answer wins.
// A question that left the slice by a chat answer tells Relay where and what via ASK_SETTLED_EVENT.

import { ASK_SETTLED_EVENT, type AskSettledDetail } from "../../asks/record";
import { DASH } from "../../format";
import { DRIVE_CLASS } from "../rendered-drive";
import { setItems, type RelayItem, type RelayVerdict } from "../../relay/store";
import type { QuestionHandle } from "./cards";
import type { ToolRecord } from "./state";
import { agentText, ownerOf } from "./approval-relay";

const SOURCE = "card-questions";
export const QUESTION_TITLE = "Question";

/** tab id -> that body's items; the source's slice is their union */
const slices = new Map<string, RelayItem[]>();
function publishAll(): void {
  setItems(SOURCE, [...slices.values()].flat());
}

export interface QuestionRelayDeps {
  /** this body's tab id, the owner of every item it publishes */
  tabId: string;
  /** the tab's display name for the item's rows, or null */
  tabName: string | null;
  /** the body's tool records, to name the subagent that owns a question card */
  tools?: Map<string, ToolRecord>;
  /** the pending question cards right now (cards.ts openQuestions, bound lazily by the mirror) */
  openQuestions: () => QuestionHandle[];
  /** true while a restore replays history: publish nothing then */
  hydrating: () => boolean;
}

/** The folded card for `key` (still in the document after a settle), or null. */
function cardOf(key: string): HTMLElement | null {
  for (const c of document.querySelectorAll<HTMLElement>("[data-ask-key]")) if (c.dataset.askKey === key) return c;
  return null;
}

export function createQuestionRelay(deps: QuestionRelayDeps) {
  const { tabId, tabName, tools, openQuestions, hydrating } = deps;
  /** keys published last pass; one that is gone now was settled somewhere */
  let known = new Set<string>();
  /** keys Relay itself is answering: their disappearance is not a chat answer */
  const viaRelay = new Set<string>();
  let lastSig = "[]";
  let disposed = false;

  function item(h: QuestionHandle): RelayItem {
    const record = { ...h.record, askerTab: tabId };
    // a question under an Agent pill names that agent, as the old subagent mirror did; the main thread has none
    const card = tools ? cardOf(h.key) : null;
    if (card && card.closest(".tool-children")) record.context = agentText(ownerOf(card, tools!));
    return {
      id: `card-question:${tabId}:${h.key}`,
      kind: "question",
      source: SOURCE,
      title: QUESTION_TITLE,
      sinceMs: record.askedAtMs,
      askerTab: tabId,
      view: { type: "question", record },
      async resolve(v: RelayVerdict) {
        viaRelay.add(h.key);
        try {
          if (v.verdict === "approve") {
            if (!v.reply) throw new Error("Answer In Chat");
            await h.answer(v.reply); // throws Already Answered, the refusal text or Not Delivered
          } else {
            if (!h.dismiss) throw new Error("Answer In Chat");
            await h.dismiss();
          }
        } catch (e) {
          viaRelay.delete(h.key);
          throw e;
        }
      },
    };
  }

  /** a question that left without Relay answering it: say where and what, from the folded card */
  function settledInChat(key: string): void {
    if (viaRelay.delete(key)) return;
    const card = cardOf(key);
    // no folded card (transcript wiped) or an agent-side end (Interrupted, Session Ended): nobody answered it
    if (!card || !card.classList.contains(DRIVE_CLASS.settled) || card.querySelector(`.${DRIVE_CLASS.result}.dim`)) return;
    const detail: AskSettledDetail = { key, where: tabName || DASH, answer: card.dataset.askAnswer ?? "" };
    window.dispatchEvent(new window.CustomEvent(ASK_SETTLED_EVENT, { detail }));
  }

  /** re-derive this body's slice from the open questions */
  function refresh(): void {
    if (disposed || hydrating()) return;
    const handles = openQuestions();
    const now = new Set(handles.map((h) => h.key));
    for (const key of known) if (!now.has(key)) settledInChat(key);
    known = now;
    const items = handles.map(item);
    // refresh runs on most events: notify the store only when the slice actually changed
    const sig = JSON.stringify(items.map((i) => [i.id, i.view]));
    if (sig === lastSig) return;
    lastSig = sig;
    if (items.length) slices.set(tabId, items); else slices.delete(tabId);
    publishAll();
  }

  /** the tab closed: its items go with it */
  function dispose(): void {
    disposed = true;
    known.clear();
    viaRelay.clear();
    if (slices.delete(tabId)) publishAll();
  }
  return { refresh, dispose };
}
