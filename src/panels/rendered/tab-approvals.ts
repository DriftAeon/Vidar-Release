// Approval records drawn as cards in the asker's own tab: a record with `drawInAskerTab` whose
// asker.tab is this tab (ctl-*, astra) also appears here as a permission card, beside its Relay card.
// Either side answers through the record's entry, which settles it once; the card leaves when the
// record does. These cards stay out of `approvals`, so they never hold the composer, Esc or the state
// chip (those key on S.pendingApproval). A PTY tab or a record with no asker tab is Relay only.

import { DRIVE_CLASS } from "../rendered-drive";
import { liveApprovals, subscribeApprovals, type ApprovalEntry } from "../../asks/approvals";
import { renderNodeMatrix } from "../../control/node-matrix";
import { iconImg } from "../../icon-img";
import { btn, el } from "./dom";
import { cardShell } from "./card-shell";

export interface TabApprovalsDeps {
  /** this body's tab id: only records whose asker.tab is this id are drawn */
  tabId: string;
  /** this tab's name, given as where an in-tab answer came from */
  tabName: string | null;
  /** the transcript element the cards are appended to */
  host: HTMLElement;
  /** true while a restore replays history: draw nothing then */
  hydrating: () => boolean;
}

const isMine = (e: ApprovalEntry, tabId: string): boolean =>
  e.record.drawInAskerTab && e.record.asker.tab === tabId;

export function createTabApprovals(deps: TabApprovalsDeps) {
  const { tabId, tabName, host, hydrating } = deps;
  const cards = new Map<string, HTMLElement>();
  let disposed = false;

  function drawCard(entry: ApprovalEntry): HTMLElement {
    const { record } = entry;
    const shell = cardShell({
      root: "div",
      classes: `blk ${DRIVE_CLASS.card} blk-tab-ask`,
      parts: ["head", "title", "body", "actions"],
      title: record.title,
      partClasses: { head: "approval-head", title: "approval-title", body: "approval-body", actions: "approval-actions" },
    });
    const card = shell.root, head = shell.head!, body = shell.body!, row = shell.actions!;
    card.dataset.approvalId = record.id;
    card.dataset.tool = record.origin;
    const sh = iconImg("shield");
    sh.title = "Permission";
    head.prepend(sh);
    if (record.question) body.append(el("div", "approval-summary", record.question));
    if (record.matrix) body.append(renderNodeMatrix(record.matrix));
    else for (const [label, value] of record.rows) {
      const r = el("div", "ask-row");
      r.append(el("span", "ask-label", label), el("span", "ask-value", value));
      body.append(r);
    }
    const msg = el("input", DRIVE_CLASS.message);
    msg.setAttribute("aria-label", "Reason");
    msg.setAttribute("placeholder", "Notes");
    const error = el("span", "approval-error");
    error.setAttribute("role", "alert");
    let busy = false;
    const decide = async (verdict: "approve" | "deny") => {
      if (busy) return;
      busy = true;
      error.textContent = "";
      allow.disabled = deny.disabled = true;
      try {
        await entry.answer({ verdict, comment: msg.value.trim(), where: tabName ?? tabId });
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
      }
      busy = false;
      allow.disabled = deny.disabled = false;
    };
    const allow = btn("Allow", DRIVE_CLASS.allow, () => void decide("approve"));
    const deny = btn("Deny", DRIVE_CLASS.deny, () => void decide("deny"));
    row.append(msg, error, allow, deny);
    return card;
  }

  /** sync the drawn cards with the registry's records for this tab */
  function refresh(): void {
    if (disposed || hydrating()) return;
    const want = new Map<string, ApprovalEntry>();
    for (const e of liveApprovals()) if (isMine(e, tabId)) want.set(e.record.id, e);
    for (const [id, card] of cards) {
      if (want.has(id) && card.isConnected) continue;
      card.remove();
      cards.delete(id);
    }
    for (const [id, e] of want) {
      if (cards.has(id)) continue;
      const card = drawCard(e);
      cards.set(id, card);
      host.appendChild(card);
    }
  }
  /** draw again from scratch (after hydration ends or a transcript reset wiped the cards) */
  function redraw(): void {
    for (const card of cards.values()) card.remove();
    cards.clear();
    refresh();
  }

  const unsubscribe = subscribeApprovals(refresh);
  refresh();

  /** the tab closed: its cards go with it */
  function dispose(): void {
    disposed = true;
    unsubscribe();
    for (const card of cards.values()) card.remove();
    cards.clear();
  }
  return { refresh, redraw, dispose };
}
