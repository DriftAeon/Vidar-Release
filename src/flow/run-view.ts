// Live run painting: status classes on nodes (S.nodeEls) and edges (edges.ts's edgeEls),
// per-node "Approval · n" title-bar chips that open the approvals sidebar (approvals-panel.ts),
// answers wired to flow_answer_permission, run-level Cancel, and the run selector list.
//
// Binding rules: (1) Approve is always the
// left button, Deny the right; (2) a run-state badge never overlaps the node body — here it's a
// plain flex sibling inserted before .flow-node-body, not an absolutely-positioned overlay, so it
// can never sit on top of it.
//
// Registers its own subscriber on runner-adapter.ts, independent of engine.ts's (§7).

import type { FlowNodeEvent, FlowRun, FlowRunNodeState, FlowRunNodeStatus } from "./run";
import { S, text, notifyPendingApprovalsChanged } from "./state";
import { edgeEls } from "./edges";
import { invoke } from "../ipc";
import { onFlowNodeEvent } from "./runner-adapter";
import { getRun } from "./runs-store";
import { elapsedLabel, markLive, startLiveClock } from "./run-clock";
// A denied permission must suppress the retry §4.2 otherwise
// allows — engine.ts already has the bookkeeping (`recordDenial`, no caller until now) and is
// the only module that owns retry policy, so this reaches back into it rather than duplicating
// the tracking here. engine.ts itself calls into this module (`paintRun`), so the two are
// mutually importing — safe under ES module live bindings since neither is used at the other's
// module-init time, only from inside event handlers called well after both have loaded.
import { recordDenial, endDeniedNode } from "./engine";
import { openApprovals, paintApprovalsPanel } from "./approvals-panel";

/** Tooltip for the run-level Cancel button — panels/flow.ts wires the button itself (to
 *  `engine.ts`'s own `cancelRun`, the only writer of `rs.canceled`/pending-approval cleanup;
 *  this module has no cancelRun of its own). */
export const CANCEL_RUN_TOOLTIP = "Cancels every live node; a turn already in flight may finish within 5s.";

const NODE_STATUS_CLASSES = [
  "flow-run-idle",
  "flow-run-queued",
  "flow-run-running",
  "flow-run-awaiting-approval",
  "flow-run-ok",
  "flow-run-error",
  "flow-run-canceled",
  "flow-run-denied",
] as const;

function statusClass(status: FlowRunNodeStatus): string {
  return `flow-run-${status}`;
}

// Statuses that show a square mark instead of the text
// pill: idle unfilled, running a pulsing amber square, ok a green check. Everything else
// (queued, awaiting-approval, error, canceled, denied) keeps the pill.
const MARK_STATUSES: ReadonlySet<FlowRunNodeStatus> = new Set(["idle", "running", "ok"]);
const MARK_ACCESSIBLE_NAME: Partial<Record<FlowRunNodeStatus, string>> = {
  idle: "Idle",
  running: "Running",
  ok: "Done",
};

function statusLabel(status: FlowRunNodeStatus): string {
  switch (status) {
    case "idle":
      return "";
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "awaiting-approval":
      return "Approval";
    case "ok":
      return "Done";
    case "error":
      return "Error";
    case "canceled":
      return "Canceled";
    case "denied":
      return "Denied";
  }
}

/** One `.flow-run-badge` per node, created lazily the first time that node gets a paint call and
 *  cached here — `nodes.ts`'s `loadGraph` rebuilds `S.nodeEls` wholesale on graph switch, so
 *  `resetRunView` (below) drops this cache in step with that rebuild rather than leaking stale
 *  elements. Lives in `.flow-node-header` (mock round 2's mark sits beside the title in the header
 *  band, not before the body — nodes.ts's header-band card, brief item 3). */
const badges = new Map<string, HTMLElement>();

function badgeFor(nodeId: string): HTMLElement | null {
  const existing = badges.get(nodeId);
  if (existing) return existing;
  const el = S.nodeEls.get(nodeId);
  if (!el) return null;
  const header = el.querySelector(".flow-node-header") ?? el;
  const badge = document.createElement("span");
  badge.className = "flow-run-badge";
  header.appendChild(badge);
  badges.set(nodeId, badge);
  return badge;
}

/** Duration/cost for the node-card footer (brief item 3: "run facts — time, tokens — in the
 *  footer when the run has them"). No per-node token count exists anywhere in FlowRunNodeState or
 *  the engine today (grepped, see report) — cost (`costUsd`) stands in for "tokens" here, the only
 *  per-node number the run actually tracks besides timing. */
function footerFacts(nodeState?: FlowRunNodeState): string[] {
  const parts: string[] = [];
  const time = elapsedLabel(nodeState?.startedAt, nodeState?.endedAt, Date.now());
  if (time) parts.push(time);
  if (nodeState?.costUsd !== undefined) parts.push(`$${nodeState.costUsd.toFixed(3)}`);
  return parts;
}

function paintNodeFooter(el: HTMLElement | undefined, status: FlowRunNodeStatus, nodeState?: FlowRunNodeState): void {
  const footer = el?.querySelector<HTMLElement>(".flow-node-footer");
  if (!footer) return;
  const parts = status === "idle" ? [] : footerFacts(nodeState);
  footer.replaceChildren(...parts.map((p) => text("", p)));
  // the time part leads when present; an unfinished node keeps it ticking between events
  const first = footer.firstElementChild as HTMLElement | null;
  if (first && parts[0]?.endsWith("s") && !parts[0].startsWith("$")) markLive(first, nodeState?.startedAt, nodeState?.endedAt);
  footer.hidden = parts.length === 0;
}

/** Applies one node's run status to its canvas element, badge and footer. Exported so a full
 *  repaint (e.g. switching the run selector to a past run) and this module's own event subscriber
 *  share one code path. `nodeState`, when the caller has it, feeds the footer's run facts. */
function paintNodeStatus(nodeId: string, status: FlowRunNodeStatus, nodeState?: FlowRunNodeState): void {
  const el = S.nodeEls.get(nodeId);
  if (el) {
    el.classList.remove(...NODE_STATUS_CLASSES);
    el.classList.add(statusClass(status));
  }
  const badge = badgeFor(nodeId);
  if (badge) {
    badge.classList.remove(...NODE_STATUS_CLASSES, "flow-run-mark");
    badge.classList.add(statusClass(status));
    if (MARK_STATUSES.has(status)) {
      badge.classList.add("flow-run-mark");
      badge.textContent = "";
      const name = MARK_ACCESSIBLE_NAME[status] ?? "";
      if (name) {
        badge.title = name;
        badge.setAttribute("aria-label", name);
      } else {
        badge.removeAttribute("title");
        badge.removeAttribute("aria-label");
      }
    } else {
      badge.textContent = statusLabel(status);
      badge.removeAttribute("title");
      badge.removeAttribute("aria-label");
    }
  }
  paintNodeFooter(el, status, nodeState);
}

/** Same status paint on the visible stroke of every edge feeding into `nodeId`, read from
 *  `run.graphSnapshot.edges` (the run's frozen snapshot, §4.1 — never the live editable graph, so
 *  an edit made after the run started never repaints an edge that isn't part of what ran). */
function paintEdgesInto(run: FlowRun, nodeId: string, status: FlowRunNodeStatus): void {
  for (const edge of run.graphSnapshot.edges) {
    if (edge.to.node !== nodeId) continue;
    const pair = edgeEls(edge.id);
    if (!pair) continue;
    pair.vis.classList.remove(...NODE_STATUS_CLASSES);
    pair.vis.classList.add(statusClass(status));
  }
}

/** Sends one Approve/Deny for a pending request. Exported for the approvals sidebar
 *  (approvals-panel.ts), which receives it as an argument rather than importing this module. */
export function answerPermission(
  runId: string,
  nodeId: string,
  attempt: number,
  permissionId: string,
  allow: boolean,
  approve: HTMLButtonElement,
  deny: HTMLButtonElement,
): void {
  approve.disabled = true;
  deny.disabled = true;
  // a stale answer (resolves false) sends nothing; the entry is already gone and its card repaints away
  void sendPermissionAnswer(runId, nodeId, attempt, permissionId, allow)
    .catch(() => {
      // best-effort: a failed answer leaves the request pending; the node stays
      // awaiting-approval and the row is repainted (still present in S.pendingApprovals) on the
      // next event, so the buttons come back rather than staying stuck disabled
      approve.disabled = false;
      deny.disabled = false;
    });
}

const answering = new Set<string>();

/** The button-less core of an answer, shared by the sidebar buttons and the Relay card. Resolves
 *  false, having sent and recorded nothing, when the request is no longer pending (answered on
 *  another surface, or cleared by a cancel): a stale Deny must never record a denial. Rejects
 *  when the invoke fails, leaving the request pending. */
export async function sendPermissionAnswer(
  runId: string,
  nodeId: string,
  attempt: number,
  permissionId: string,
  allow: boolean,
): Promise<boolean> {
  // in flight counts as answered: a second surface clicking inside the invoke window must not
  // record a denial for a request the first click already settled
  if (!S.pendingApprovals.has(permissionId) || answering.has(permissionId)) return false;
  answering.add(permissionId);
  // §4.2: a retry never happens after a denied permission — engine.ts's own retry check
  // (`shouldRetry`) reads this before ever re-running the node, so it must be recorded before
  // (or race-free with) the "error" event flow.rs's cancel/deny path produces.
  if (!allow) recordDenial(runId, nodeId, attempt);
  try {
    await invoke("flow_answer_permission", { runId, nodeId, permissionId, allow });
  } finally {
    answering.delete(permissionId);
  }
  // `engine.ts` owns `S.pendingApprovals` bookkeeping and only clears a node's whole queue on a
  // terminal status, never a single answered entry — flow.rs emits nothing for this node while
  // other requests are still open, so nothing else removes this one. Drop just this permission
  // and repaint the node's queue immediately rather than waiting on the next event.
  S.pendingApprovals.delete(permissionId);
  notifyPendingApprovalsChanged();
  paintApprovalQueue(runId, nodeId);
  // Deny is terminal for the node: end its session now, after the deny is delivered, so the
  // agent never gets to retry the tool and ask again (engine.ts's endDeniedNode).
  if (!allow) endDeniedNode(runId, nodeId);
  return true;
}

/** The node's "Approval · n" chip in the title bar: no extra body line whatever n is, so the node
 *  never grows with its queue. Clicking it opens the approvals sidebar on the oldest entry. */
function buildPendingBlock(): HTMLButtonElement {
  const block = document.createElement("button");
  block.type = "button";
  block.className = "flow-run-badge flow-run-awaiting-approval flow-approval-block";
  block.title = "Opens this node's pending approvals.";
  // Without this, the node's own pointerdown handler (nodes.ts) fires first, selects the node,
  // calls setPointerCapture and starts a node drag — the click never reaches the block.
  block.addEventListener("pointerdown", (e) => e.stopPropagation());
  block.addEventListener("click", (e) => {
    e.stopPropagation();
    const first = block.dataset.permissionId;
    if (first) openApprovals(first, answerPermission);
  });
  return block;
}

/** Renders the node's pending block from `S.pendingApprovals`: every entry whose `nodeId`
 *  matches counts, the oldest (Map insertion order) is the one a click opens in the sidebar.
 *  Removes the block once the node has none, then repaints the sidebar
 *  (approvals-panel.ts) — every path that changes the pending set ends here.
 *
 *  `runId`, when given, also filters by it (two concurrent runs of
 *  the same graph reuse the same node ids, so a `nodeId`-only filter mixed both runs' approval
 *  rows into one queue). Left optional — `undefined` matches every run's entries for the node, the
 *  pre-existing behaviour, for the one call site (`answerPermission`) that doesn't have a `FlowRun`
 *  handy and only ever clears its own single entry regardless. */
export function paintApprovalQueue(runId: string | undefined, nodeId: string): void {
  paintPendingBlock(runId, nodeId);
  paintApprovalsPanel(answerPermission);
}

function paintPendingBlock(runId: string | undefined, nodeId: string): void {
  const el = S.nodeEls.get(nodeId);
  if (!el) return;
  const header = el.querySelector(".flow-node-header");
  if (!header) return;

  const ids: string[] = [];
  for (const [id, a] of S.pendingApprovals) if (a.nodeId === nodeId && (runId === undefined || a.runId === runId)) ids.push(id);

  let block = header.querySelector<HTMLButtonElement>(".flow-approval-block");
  if (ids.length === 0) {
    block?.remove();
    return;
  }
  if (!block) {
    block = buildPendingBlock();
    header.appendChild(block);
  }
  block.dataset.permissionId = ids[0];
  block.textContent = `Approval · ${ids.length}`;
}

/** Repaints every node, edge and (for the live run only) approval queue from a stored `FlowRun`
 *  record — the run selector's "select a past run, replay its stored nodes map read-only" (§5)
 *  and the one place that can resync the view after any of `engine.ts`'s status changes that
 *  don't carry their own `flow-node-event` (queued, a caught spawn error, a run-level cancel,
 *  finish). `readOnly`
 *  (true for a past run from the selector) skips the approval queue entirely — a finished run has
 *  none, and this never reaches into the live run's `S.pendingApprovals` for a different run's
 *  nodes. Call this after wiring the run selector and after every engine persist. */
export function paintRun(run: FlowRun, opts: { readOnly?: boolean } = {}): void {
  clearRunPaint();
  for (const [nodeId, node] of Object.entries(run.nodes)) {
    paintNodeStatus(nodeId, node.status, node);
    paintEdgesInto(run, nodeId, node.status);
    if (!opts.readOnly) paintApprovalQueue(run.id, nodeId);
  }
}

/** Resets every known node/edge on the canvas to idle and drops any approval-queue DOM (but never
 *  touches `S.pendingApprovals` itself — that stays engine.ts's). Call before `paintRun` repaints
 *  from a record, and on a graph switch so a previous run's badges don't linger on nodes that
 *  belong to the newly-loaded graph. */
export function clearRunPaint(): void {
  for (const nodeId of S.nodeEls.keys()) {
    paintNodeStatus(nodeId, "idle");
    const el = S.nodeEls.get(nodeId);
    el?.querySelector(".flow-approval-block")?.remove();
  }
  paintApprovalsPanel(answerPermission);
  for (const edge of S.edges) {
    const pair = edgeEls(edge.id);
    pair?.vis.classList.remove(...NODE_STATUS_CLASSES);
  }
}

/** Clears the per-node badge cache — call after `nodes.ts`'s `loadGraph` rebuilds `S.nodeEls`
 *  (graph switch or Reset layout), so a stale badge element for a now-gone node id is never
 *  reused and a real node doesn't inherit another graph's leftover badge. */
export function resetRunView(): void {
  badges.clear();
}

let unsubscribe: (() => void) | null = null;
let stopClock: (() => void) | null = null;

/** Registers this module's own subscriber on runner-adapter.ts, independent of engine.ts's (§7):
 *  paints node/edge status and repaints the approval queue on every deliverable event (stale-
 *  attempt and unheld-run events are already dropped by runner-adapter.ts before they reach any
 *  subscriber). `S.pendingApprovals` itself is read-only here: `engine.ts` is the only writer (adds on
 *  awaiting-approval, drops a node's entries on a terminal status per §2); this module only reads
 *  it to render, plus the one delete `answerPermission` above does for the single entry it just
 *  answered. An event for a
 *  run that is neither the active run nor a run of the active graph is dropped — `S.activeRunId`
 *  is set when a run starts. Call once at Flow mount; call the returned function to
 *  unregister. */
export function initRunView(): () => void {
  unsubscribe?.();
  stopClock?.();
  stopClock = startLiveClock();
  unsubscribe = onFlowNodeEvent((event: FlowNodeEvent) => {
    // Gated on `S.activeRunId` alone, not a `graphId` fallback:
    // `S.activeRunId` is now the run selector's own "currently shown run" (panels/flow.ts), kept
    // in sync on every explicit selection — a `graphId` fallback repainted the canvas from
    // whichever run of the active graph last changed, silently overwriting a manually-selected
    // past run, and mixed two concurrent runs' approval queues onto the same node ids.
    if (event.runId !== S.activeRunId) return;
    const run = getRun(event.runId);
    // "denied" is engine-derived (flow.rs sends "ok"); engine.ts's subscriber runs first and has
    // already stored it, so never repaint it back to "ok" from the raw event.
    const status: FlowRunNodeStatus = run?.nodes[event.nodeId]?.status === "denied" ? "denied" : event.status;

    paintNodeStatus(event.nodeId, status, run?.nodes[event.nodeId]);
    if (run) paintEdgesInto(run, event.nodeId, status);
    paintApprovalQueue(run?.id, event.nodeId);
  });
  return () => {
    unsubscribe?.();
    unsubscribe = null;
    stopClock?.();
    stopClock = null;
  };
}
