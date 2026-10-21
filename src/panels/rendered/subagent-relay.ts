// Subagent approvals as Relay items (kind "card"), modelled on flow/approvals-relay.ts: a permission a
// subagent is waiting on sits deep in a child pill (`.tool-children` of its Agent pill), where a
// ~100-call agent buries it. Each body owns one slice of the shared "subagent-approvals" source and
// re-derives it from its pending `approvals` map on every refreshState() and card attach, so an
// answer in chat, a turn end or a cancel drops the item on the next pass; dispose drops the slice.
// Main-thread approvals (a card not under `.tool-children`) never publish.
// Approve/Deny click the in-chat card's own Allow/Deny buttons: one answer path for both surfaces.

import { DASH } from "../../format";
import { DRIVE_CLASS } from "../rendered-drive";
import { setItems, type RelayItem, type RelayVerdict } from "../../relay/store";
import type { ToolRecord } from "./state";

const SOURCE = "subagent-approvals";
export const SUBAGENT_APPROVAL_TITLE = "Agent Needs You";

/** tab id -> that body's items; the source's slice is their union */
const slices = new Map<string, RelayItem[]>();
function publishAll(): void {
  setItems(SOURCE, [...slices.values()].flat());
}

export interface SubagentRelayDeps {
  tabId: string;
  tabName: string | null;
  tools: Map<string, ToolRecord>;
  /** pending approval cards by request id (rendered.ts `approvals`) */
  approvals: Map<string, HTMLElement>;
}

/** The Agent call whose child list holds `card` (innermost when agents nest). */
function ownerOf(card: HTMLElement, tools: Map<string, ToolRecord>): ToolRecord | null {
  const box = card.closest<HTMLElement>(".tool-children");
  if (!box) return null;
  for (const t of tools.values()) if (t.children === box) return t;
  return null;
}

function agentText(t: ToolRecord | null): string {
  const type = t?.subagentType || "Agent";
  return t?.subagentDesc ? `${type} · ${t.subagentDesc}` : type;
}

/** Answer through the card's own buttons, the exact handler a click in chat runs. */
function answer(card: HTMLElement, v: RelayVerdict): void {
  const yes = v.verdict === "approve";
  const b = card.querySelector<HTMLButtonElement>(`.${yes ? DRIVE_CLASS.allow : DRIVE_CLASS.deny}`);
  if (!b || !b.isConnected) throw new Error("Already Answered");
  if (b.disabled) throw new Error("Answer In Chat"); // a question or form card needs its picks
  const msg = card.querySelector<HTMLInputElement>(`.${DRIVE_CLASS.message}`);
  if (!yes && msg && v.comment.trim()) msg.value = v.comment.trim();
  card.dataset.relayAnswer = "1"; // cards.ts settle reads and clears it: no composer focus for a Relay answer
  b.click();
  delete card.dataset.relayAnswer; // a click that never reached settle must not leave the flag behind
}

export function createSubagentRelay(deps: SubagentRelayDeps) {
  const { tabId, tabName, tools, approvals } = deps;
  const firstSeen = new Map<string, number>();
  let disposed = false;
  let lastSig = "[]";

  function sync(): void {
    if (disposed) return;
    const items: RelayItem[] = [];
    for (const [requestId, card] of approvals) {
      if (!card.closest(".tool-children")) continue; // main thread (or not yet in its pill): out of scope
      const owner = ownerOf(card, tools);
      if (!firstSeen.has(requestId)) firstSeen.set(requestId, Date.now());
      const tool = card.querySelector<HTMLElement>(".approval-head .tool-name")?.textContent || card.dataset.tool || DASH;
      items.push({
        id: `subagent-approval:${tabId}:${requestId}`,
        kind: "card",
        source: SOURCE,
        title: SUBAGENT_APPROVAL_TITLE,
        sinceMs: firstSeen.get(requestId) ?? Date.now(),
        view: {
          type: "card",
          rows: [
            ["Agent", agentText(owner)],
            ["Tab", tabName || DASH],
            ["Tool", tool],
            ["Request", card.dataset.summary || DASH],
          ],
        },
        async resolve(v: RelayVerdict) {
          // a card answered elsewhere has left `approvals`: nothing is sent, the next sync drops the item
          if (approvals.get(requestId) !== card) throw new Error("Already Answered");
          answer(card, v);
        },
      });
    }
    for (const id of [...firstSeen.keys()]) if (!approvals.has(id)) firstSeen.delete(id);
    // refreshState runs on most events: notify the store only when the slice actually changed
    const sig = JSON.stringify(items.map((i) => [i.id, i.view]));
    if (sig === lastSig) return;
    lastSig = sig;
    if (items.length) slices.set(tabId, items); else slices.delete(tabId);
    publishAll();
  }

  /** The tab closed: its items go with it. */
  function dispose(): void {
    disposed = true;
    firstSeen.clear();
    if (slices.delete(tabId)) publishAll();
  }

  return { sync, dispose };
}
