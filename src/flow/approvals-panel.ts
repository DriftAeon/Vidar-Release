// Approvals sidebar: every pending approval of the shown run (S.pendingApprovals filtered by
// S.activeRunId), one card each with the request's detail (rendered/approval-detail.ts) and
// Approve/Deny. Docked to the right of .flow-canvas inside .flow-body, created on first need.
//
// Never imports run-view.ts at runtime: run-view.ts drives this module (paintApprovalQueue calls
// paintApprovalsPanel, the node's pending block calls openApprovals) and hands its own
// answerPermission in, so the two never form an import cycle.

import type { FlowPendingApproval } from "./run";
import type { answerPermission } from "./run-view";
import { S, text } from "./state";
import { getRun } from "./runs-store";
import { iconImg } from "../icon-img";
import { approvalDetail, approvalToolLabel } from "../panels/rendered/approval-detail";

type Answer = typeof answerPermission;

let panel: HTMLElement | null = null;
let list: HTMLElement | null = null;
let count: HTMLElement | null = null;
/** permission ids the list was last built from, in order; a node event that leaves them alone
 *  repaints nothing, so a running node's frequent events never reset the scroll position */
let builtKey = "";
/** Hide was clicked; cleared when a new approval arrives or a node's pending block is clicked */
let dismissed = false;
let seen = new Set<string>();

function pending(): [string, FlowPendingApproval][] {
  const out: [string, FlowPendingApproval][] = [];
  if (!S.activeRunId) return out;
  for (const [id, a] of S.pendingApprovals) if (a.runId === S.activeRunId) out.push([id, a]);
  return out;
}

function nodeTitle(a: FlowPendingApproval): string {
  return getRun(a.runId)?.graphSnapshot.nodes.find((n) => n.id === a.nodeId)?.title ?? a.nodeId;
}

/** The panel inside the current mount's .flow-body; rebuilt when Flow was remounted. */
function ensurePanel(): HTMLElement | null {
  const body = S.rootEl?.querySelector<HTMLElement>(".flow-body");
  if (!body) return null;
  if (panel && panel.parentElement === body) return panel;
  panel = document.createElement("aside");
  panel.className = "flow-approvals";
  panel.hidden = true;
  const head = document.createElement("div");
  head.className = "flow-approvals-head";
  head.appendChild(text("flow-approvals-title", "Approvals Pending"));
  count = text("flow-approvals-count", "");
  head.appendChild(count);
  const hide = document.createElement("button");
  hide.type = "button";
  hide.className = "flow-approvals-hide";
  hide.textContent = "Hide";
  hide.addEventListener("click", () => {
    dismissed = true;
    if (panel) panel.hidden = true;
  });
  head.appendChild(hide);
  list = document.createElement("div");
  list.className = "flow-approvals-list";
  panel.append(head, list);
  body.appendChild(panel);
  builtKey = "";
  return panel;
}

function buildCard(permissionId: string, a: FlowPendingApproval, answer: Answer): HTMLElement {
  const card = document.createElement("div");
  card.className = "flow-approval-card";
  card.dataset.permissionId = permissionId;
  const head = document.createElement("div");
  head.className = "flow-approval-card-head";
  const tile = document.createElement("span");
  tile.className = "title-tile"; // the gate title bar's icon tile (title-bar.css)
  tile.append(iconImg("shield"));
  head.append(tile, text("flow-approval-node", nodeTitle(a)), text("flow-approval-tool", approvalToolLabel(a.request.tool, a.request.input)));
  const detail = document.createElement("div");
  detail.className = "flow-approval-detail";
  const bytes = JSON.stringify(a.request.input ?? null)?.length ?? 0;
  detail.append(...approvalDetail(a.request.tool, a.request.input, bytes));
  const buttons = document.createElement("div");
  buttons.className = "flow-approve-buttons";
  // Approve is always the left button, Deny the right.
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "flow-approve-btn flow-approve-approve";
  approve.textContent = "Approve";
  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "flow-approve-btn flow-approve-deny";
  deny.textContent = "Deny";
  approve.addEventListener("click", () => answer(a.runId, a.nodeId, a.attempt, permissionId, true, approve, deny));
  deny.addEventListener("click", () => answer(a.runId, a.nodeId, a.attempt, permissionId, false, approve, deny));
  buttons.append(approve, deny);
  card.append(head, detail, buttons);
  return card;
}

/** Repaints the sidebar from S.pendingApprovals. Shown while the shown run has a pending
 *  approval (unless hidden by the user since the last new one), hidden otherwise. */
export function paintApprovalsPanel(answer: Answer): void {
  const entries = pending();
  if (entries.length === 0 && !panel) return;
  const el = ensurePanel();
  if (!el || !list || !count) return;
  const ids = entries.map(([id]) => id);
  if (ids.some((id) => !seen.has(id))) dismissed = false;
  seen = new Set(ids);
  const key = ids.join("|");
  if (key !== builtKey) {
    builtKey = key;
    list.replaceChildren(...entries.map(([id, a]) => buildCard(id, a, answer)));
  }
  count.textContent = String(entries.length);
  el.hidden = entries.length === 0 || dismissed;
}

/** A node's pending block was clicked: show the sidebar and bring that approval into view. */
export function openApprovals(permissionId: string, answer: Answer): void {
  dismissed = false;
  paintApprovalsPanel(answer);
  const card = list?.querySelector<HTMLElement>(`[data-permission-id="${CSS.escape(permissionId)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest" });
  card.classList.remove("flow-approval-focus");
  void card.offsetWidth; // restart the highlight when the same card is picked twice
  card.classList.add("flow-approval-focus");
  card.querySelector<HTMLButtonElement>(".flow-approve-approve")?.focus({ preventScroll: true });
}
