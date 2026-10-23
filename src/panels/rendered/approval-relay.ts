// A Rendered body's pending approval cards as approval records (asks/approvals.ts), which Relay draws
// through relay/source-approvals.ts. Main-thread cards publish as origin "rendered" ("Tool Approval");
// a card inside a subagent's pill (`.tool-children` of its Agent pill, where a ~100-call agent buries
// it) publishes as origin "subagent" ("Agent Needs You") with an Agent row. Each body owns one slice,
// re-derived from its pending `approvals` map on every refreshState() and card attach, so an answer in
// chat, a turn end or a cancel drops the record on the next pass; dispose drops the slice.
// Answering clicks the in-chat card's own Allow/Deny buttons: one answer path for both surfaces.

import { DASH } from "../../format";
import { DRIVE_CLASS } from "../rendered-drive";
import { APPROVAL_TITLES, type ApprovalAnswer } from "../../asks/approval";
import { setApprovalSlice, type ApprovalEntry } from "../../asks/approvals";
import type { ToolRecord } from "./state";

export interface ApprovalRelayDeps {
  tabId: string;
  tabName: string | null;
  tools: Map<string, ToolRecord>;
  /** pending approval cards by request id (rendered.ts `approvals`) */
  approvals: Map<string, HTMLElement>;
  /** true while a restore replays history: publish nothing then */
  hydrating?: () => boolean;
}

/** The Agent call whose child list holds `card` (innermost when agents nest). */
export function ownerOf(card: HTMLElement, tools: Map<string, ToolRecord>): ToolRecord | null {
  const box = card.closest<HTMLElement>(".tool-children");
  if (!box) return null;
  for (const t of tools.values()) if (t.children === box) return t;
  return null;
}

export function agentText(t: ToolRecord | null): string {
  const type = t?.subagentType || "Agent";
  return t?.subagentDesc ? `${type} · ${t.subagentDesc}` : type;
}

/** Answer through the card's own buttons, the exact handler a click in chat runs. */
function answer(card: HTMLElement, a: Pick<ApprovalAnswer, "verdict" | "comment">): void {
  const yes = a.verdict === "approve";
  const b = card.querySelector<HTMLButtonElement>(`.${yes ? DRIVE_CLASS.allow : DRIVE_CLASS.deny}`);
  if (!b || !b.isConnected) throw new Error("Already Answered");
  if (b.disabled) throw new Error("Answer In Chat"); // a form card needs its picks
  const msg = card.querySelector<HTMLInputElement>(`.${DRIVE_CLASS.message}`);
  if (!yes && msg && a.comment.trim()) msg.value = a.comment.trim();
  card.dataset.relayAnswer = "1"; // cards.ts settle reads and clears it: no composer focus for a Relay answer
  b.click();
  delete card.dataset.relayAnswer; // a click that never reached settle must not leave the flag behind
}

export function createApprovalRelay(deps: ApprovalRelayDeps) {
  const { tabId, tabName, tools, approvals } = deps;
  const source = `rendered-approvals:${tabId}`;
  const firstSeen = new Map<string, number>();
  let disposed = false;
  let lastSig = "[]";

  function sync(): void {
    if (disposed || deps.hydrating?.()) return;
    const entries: ApprovalEntry[] = [];
    for (const [requestId, card] of approvals) {
      if (card.classList.contains("blk-question")) continue; // question cards publish through question-relay.ts
      const sub = card.closest(".tool-children") !== null;
      if (!firstSeen.has(requestId)) firstSeen.set(requestId, Date.now());
      const tool = card.querySelector<HTMLElement>(".approval-head .tool-name")?.textContent || card.dataset.tool || DASH;
      const rows: [string, string][] = [
        ["Tab", tabName || DASH],
        ["Tool", tool],
        ["Request", card.dataset.summary || DASH],
      ];
      if (sub) rows.unshift(["Agent", agentText(ownerOf(card, tools))]);
      const origin = sub ? "subagent" : "rendered";
      entries.push({
        record: {
          // tab + request id for every origin: a card that moves into its pill keeps its id
          id: `rendered-approval:${tabId}:${requestId}`,
          origin,
          title: APPROVAL_TITLES[origin],
          asker: { tab: tabId, label: tabName || DASH, verified: false },
          rows,
          askedAtMs: firstSeen.get(requestId) ?? Date.now(),
          comment: false,
          drawInAskerTab: false, // the card is already in this tab's chat
        },
        async answer(a) {
          // a card answered elsewhere has left `approvals`: nothing is sent, the next sync drops the record
          if (approvals.get(requestId) !== card) throw new Error("Already Answered");
          answer(card, a);
        },
      });
    }
    for (const id of [...firstSeen.keys()]) if (!approvals.has(id)) firstSeen.delete(id);
    // refreshState runs on most events: notify the registry only when the slice actually changed
    // (the title is left out: the rows already say whether the card sits in a subagent's pill)
    const sig = JSON.stringify(entries.map((e) => [e.record.id, e.record.rows]));
    if (sig === lastSig) return;
    lastSig = sig;
    setApprovalSlice(source, entries);
  }

  /** The tab closed: its records go with it. */
  function dispose(): void {
    disposed = true;
    firstSeen.clear();
    if (lastSig !== "[]") setApprovalSlice(source, []);
    lastSig = "[]";
  }

  return { sync, dispose };
}
