// The Run Flow approval as a Relay item (kind "card"): the same rows as the ask modal, posted while
// the modal's ask is in flight so either surface can answer. The answer goes back through the
// caller's `answer` (askgate's answerAsk), never into the flow start itself; the first answer wins
// and the caller clears the item once the ask settles, whichever side answered.

import { setItems, type RelayItem, type RelayVerdict } from "./store";
import type { NodeMatrix } from "../control/node-matrix";

const SOURCE = "flow-card";
export const FLOW_CARD_TITLE = "Run Flow";

const live = new Map<string, RelayItem>();

function publish(): void {
  setItems(SOURCE, [...live.values()]);
}

export interface FlowCardPost {
  /** the card's id (unique per card) */
  id: string;
  rows: [string, string][];
  matrix?: NodeMatrix;
  sinceMs: number;
  /** Relay Approve or Deny; resolves the in-flight ask and returns false when it was already answered */
  answer(approved: boolean): boolean;
}

export function postFlowCard(card: FlowCardPost): void {
  live.set(card.id, {
    id: card.id,
    kind: "card",
    source: SOURCE,
    title: FLOW_CARD_TITLE,
    sinceMs: card.sinceMs,
    view: { type: "card", rows: card.rows, matrix: card.matrix },
    async resolve(v: RelayVerdict) {
      card.answer(v.verdict === "approve");
    },
  });
  publish();
}

/** The ask settled (answered on either surface, expired or cancelled): the item goes. */
export function clearFlowCard(id: string): void {
  if (live.delete(id)) publish();
}
