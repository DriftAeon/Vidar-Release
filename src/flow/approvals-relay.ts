// Flow tool approvals as Relay items (kind "card"): every pending request of every run, so a run
// started over the bus (which never sets S.activeRunId) still shows its approvals somewhere.
// One item per request (id `flow-approval:<permissionId>`); each item's resolve closes over its
// own permission id, so answering one never answers another. A card whose request was answered
// elsewhere (canvas sidebar, a cancel) is dropped on the pending-changed notify, and a click on a
// stale one sends nothing (run-view.ts's sendPermissionAnswer refuses before recording a denial).

import { S, onPendingApprovalsChanged } from "./state";
import { initEngine } from "./engine";
import { onFlowNodeEvent } from "./runner-adapter";
import { getRun } from "./runs-store";
import { sendPermissionAnswer } from "./run-view";
import { setItems, type RelayItem, type RelayVerdict } from "../relay/store";
import { approvalToolLabel } from "../panels/rendered/approval-detail";
import { cardText } from "../control/lane-card";

const SOURCE = "flow-approvals";
export const FLOW_APPROVAL_TITLE = "Tool Approval";

const firstSeen = new Map<string, number>();
let started = false;

function requestText(input: unknown): string {
  const cmd = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
  if (typeof cmd === "string" && cmd) return cardText(cmd);
  return cardText(JSON.stringify(input ?? null) ?? "null");
}

function publish(): void {
  const items: RelayItem[] = [];
  const live = new Set<string>();
  for (const [permissionId, a] of S.pendingApprovals) {
    live.add(permissionId);
    if (!firstSeen.has(permissionId)) firstSeen.set(permissionId, Date.now());
    const run = getRun(a.runId);
    const flow = run?.graphSnapshot.name ?? a.runId;
    const node = run?.graphSnapshot.nodes.find((n) => n.id === a.nodeId)?.title ?? a.nodeId;
    items.push({
      id: `flow-approval:${permissionId}`,
      kind: "card",
      source: SOURCE,
      title: FLOW_APPROVAL_TITLE,
      sinceMs: firstSeen.get(permissionId) ?? Date.now(),
      view: {
        type: "card",
        rows: [
          ["Flow", flow],
          ["Node", node],
          ["Tool", approvalToolLabel(a.request.tool, a.request.input)],
          ["Request", requestText(a.request.input)],
        ],
        matrix: {
          nodes: [], fields: [],
          facts: [
            { label: "Flow", icon: "flow", value: flow, strong: true },
            { label: "Node", icon: "node", value: node },
            { label: "Tool", icon: "tool", value: approvalToolLabel(a.request.tool, a.request.input), strong: true },
            { label: "Request", icon: "request", value: requestText(a.request.input), block: true },
          ],
        },
      },
      async resolve(v: RelayVerdict) {
        // false = already answered; the slice drops the item on the notify either way
        await sendPermissionAnswer(a.runId, a.nodeId, a.attempt, permissionId, v.verdict === "approve");
      },
    });
  }
  for (const id of [...firstSeen.keys()]) if (!live.has(id)) firstSeen.delete(id);
  setItems(SOURCE, items);
}

/** Boot-time start (control/listen.ts). Idempotent. `initEngine` runs first so the engine's node
 *  event handler is registered before this module's, and the pending entry exists when it reads. */
export function startFlowApprovalRelay(): void {
  if (started) return;
  started = true;
  initEngine();
  onFlowNodeEvent(publish);
  onPendingApprovalsChanged(publish);
}
