// Approval records as Relay items (kind "card"): the only builder of approval RelayItems. The answer goes
// back through the record's entry, which settles it once; a second answerer gets `Already Answered`.

import { liveApprovals, subscribeApprovals, type ApprovalEntry } from "../asks/approvals";
import { setItems, type RelayItem, type RelayVerdict } from "./store";

const SOURCE = "approvals";
let started = false;

function toItem(entry: ApprovalEntry): RelayItem {
  const r = entry.record;
  return {
    id: r.id,
    kind: "card",
    source: SOURCE,
    title: r.title,
    sinceMs: r.askedAtMs,
    view: { type: "card", rows: r.rows, matrix: r.matrix, comment: r.comment },
    askerTab: r.asker.tab,
    async resolve(v: RelayVerdict) {
      await entry.answer({ verdict: v.verdict === "approve" ? "approve" : "deny", comment: v.comment, where: "Relay" });
    },
  };
}

function publish(entries: readonly ApprovalEntry[]): void {
  setItems(SOURCE, entries.map(toItem));
}

export function startApprovalSource(): void {
  if (started) return;
  started = true;
  subscribeApprovals(publish);
  publish(liveApprovals());
}
