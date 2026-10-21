// Wiring: chain execution over topo.ts, persists the run record (§4.1), pendingApprovals
// bookkeeping, academySuggestions from the preset=academy node, cancel. Not under `node --test`
// (§7's leaf-module rule) — it imports S, invoke and the prefs-backed run store; render.ts and topo.ts, the
// logic it wires, are tested directly instead.
// Wired into panels/flow.ts's RUN/Cancel controls.

import { invoke } from "../ipc";
import type { FlowGraph, FlowNode } from "./model";
import type { FlowRun, FlowRunNodeState, FlowRunStatus, FlowNodeEvent } from "./run";
import { OUTPUT_CAP_MARKER, resolveHandoffText } from "./run";
import { backendOfModel } from "./runner";
import { modeFor, resolveNodeModes, type NodeModes } from "./permission-mode";
import { S, notifyPendingApprovalsChanged } from "./state";
import { topoSort } from "./topo";
import { renderPrompt, shouldRetry, nextAttemptNumber, settleTerminal, completedRunStatus } from "./render";
import { onFlowNodeEvent, markRunHeld, markRunUnheld, setCurrentAttempt, startRunnerAdapter } from "./runner-adapter";
// Engine-only status changes must repaint: run-view.ts's own subscriber only
// sees `flow-node-event`s, but a "queued" state, a caught spawn error, and cancelRun's own
// no-live-attempt finish (below) never emit one — persistRun is the one call already on every
// such path, so wiring the repaint there (rather than a second subscriber on engine.ts's writes,
// which persistRun already gates to signature changes) is the smaller seam.
import { paintRun, paintApprovalQueue } from "./run-view";
// runs-store.ts is the single
// writer of vidar.flow.runs.v1 — its own upsertRun doc says "Called by engine.ts". A second
// read/write/evict of the same key here would let whichever side persisted
// last wipe the other's in-memory list back to storage, losing run records (and run-view.ts's
// getRun/edge-painting would silently find nothing for a live run).
import { upsertRun } from "./runs-store";

/** §4.1 asks for persistence on status transitions only, not on every one of the 4 Hz
 *  "running" text events — a run keyed by (own status):(nodeId:status:attempts,...) so a costUsd-
 *  only or text-only event, which changes neither, is a no-op write. Cleared in finishRun. */
const lastPersistedSignature = new Map<string, string>();

function runSignature(run: FlowRun): string {
  const nodeSig = Object.values(run.nodes)
    .map((n) => `${n.nodeId}:${n.status}:${n.attempts}`)
    .join(",");
  return `${run.status}:${nodeSig}`;
}

function persistRun(run: FlowRun): void {
  const sig = runSignature(run);
  if (lastPersistedSignature.get(run.id) === sig) return;
  lastPersistedSignature.set(run.id, sig);
  upsertRun(run);
  // Only the run the toolbar is currently showing — a background run (none exist in v1, but
  // never assume) must not repaint nodes/edges that belong to whatever run-view.ts is displaying.
  if (run.id === S.activeRunId) {
    try { paintRun(run); } catch (error) { console.error("[flow] run paint failed:", error); }
  }
}

function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Agent-node ids in execution order. v1's graph is a validated straight chain (§3), but this
 *  runs the same `topo.ts` a branching v2 graph would need — falls back to declared node order
 *  only if the graph has a cycle (unreachable past `validate.ts`, never reached in v1). */
function agentChain(graph: FlowGraph): string[] {
  const order = topoSort(
    graph.nodes.map((n) => n.id),
    graph.edges.map((e) => ({ from: e.from.node, to: e.to.node })),
  );
  const ids = order ?? graph.nodes.map((n) => n.id);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return ids.filter((id) => byId.get(id)?.kind === "agent");
}

function inputContent(graph: FlowGraph): string {
  const node = graph.nodes.find((n) => n.kind === "input");
  return node?.fields.find((f) => f.k === "content")?.v ?? "";
}

function addonValue(node: FlowNode, kind: string): string | undefined {
  return node.addons?.find((a) => a.kind === kind)?.value;
}

interface RunEngineState {
  run: FlowRun;
  graph: FlowGraph;
  chain: string[];
  upstreamOutputs: Record<string, string>;
  canceled: boolean;
  /** `${nodeId}:${attempt}` seen a denied permission this attempt (§4.2 says a
   *  retry never happens after a denied permission, so an
   *  attempt the user explicitly denied a tool on must not be retried and asked again). */
  deniedAttempts: Set<string>;
  /** Per-node permission mode, resolved once for the run (the bus card's value, or looked up at start). */
  modes: Promise<NodeModes>;
}

/** One lookup of the user's mode per agent node; the bus card calls it before showing, the canvas at start. */
export function resolveRunModes(graph: FlowGraph): Promise<NodeModes> {
  return resolveNodeModes(graph, (models) => invoke("flow_permission_modes", { models }), backendOfModel);
}

/** Call when a permission is answered `allow:false`. Called from run-view.ts's answerPermission
 *  before it invokes `flow_answer_permission`, so the retry-suppression logic stays with the rest
 *  of the retry policy in this module. */
export function recordDenial(runId: string, nodeId: string, attempt: number): void {
  const rs = liveRuns.get(runId);
  if (!rs) return;
  rs.deniedAttempts.add(`${nodeId}:${attempt}`);
  // Carried on the run record too; persisted with the node's next status change (the terminal
  // event), when handleNodeEvent turns a clean exit into "denied".
  setNodeState(rs.run, nodeId, { denied: true });
}

const liveRuns = new Map<string, RunEngineState>();
let controlStartReserved = false;

export function reserveControlStart(): () => void {
  if (controlStartReserved || liveRuns.size > 0) throw new Error("flow busy");
  controlStartReserved = true;
  return () => { controlStartReserved = false; };
}
let adapterSubscribed = false;

function ensureAdapterSubscribed(): void {
  if (adapterSubscribed) return;
  adapterSubscribed = true;
  startRunnerAdapter();
  onFlowNodeEvent(handleNodeEvent);
}

/** Call once at Flow mount, before `run-view.ts`'s `initRunView`: `initRunView` would otherwise register the first subscriber (at mount), while this
 *  module's own subscriber registered lazily on the first RUN click, so run-view.ts's handler for
 *  the very first `awaiting-approval` event of a run always fired before `handleNodeEvent` had
 *  added the `S.pendingApprovals` entry it reads — the first permission request of a run rendered
 *  no row until a second request (or the next event) repainted it. Idempotent past the first
 *  call, same as the lazy path RUN still takes for a session where Flow mounted before this was
 *  wired. */
export function initEngine(): void {
  ensureAdapterSubscribed();
}

function setNodeState(run: FlowRun, nodeId: string, patch: Partial<FlowRunNodeState>): void {
  const prev = run.nodes[nodeId];
  run.nodes[nodeId] = { ...prev, nodeId, ...patch } as FlowRunNodeState;
}

function removePendingForNode(runId: string, nodeId: string): void {
  let removed = false;
  for (const [id, approval] of S.pendingApprovals) {
    if (approval.runId === runId && approval.nodeId === nodeId) {
      S.pendingApprovals.delete(id);
      removed = true;
    }
  }
  if (removed) notifyPendingApprovalsChanged();
}

async function runNode(rs: RunEngineState, nodeId: string, attempt: number): Promise<void> {
  const node = rs.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const prompt = renderPrompt({
    node,
    chain: rs.chain,
    inputContent: inputContent(rs.graph),
    upstreamOutputs: rs.upstreamOutputs,
  });
  // No "cwd" addon: flow_run_node's Rust side defaults to its own repo_root():
  // an agent node with no cwd addon must never run in the Vidar process's own working directory,
  // since a write-capable agent could then act in the wrong tree; resolving it in Rust instead of
  // hardcoding a path here means it tracks the actual checkout, not a literal src/flow/engine.ts
  // was shipped with.
  const cwd = addonValue(node, "cwd") ?? "";
  const allowlist = (addonValue(node, "permission-allowlist") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  setCurrentAttempt(rs.run.id, nodeId, attempt);
  setNodeState(rs.run, nodeId, {
    status: "queued",
    attempts: attempt,
    startedAt: rs.run.nodes[nodeId]?.startedAt ?? new Date().toISOString(),
    // A new attempt starts clean — an earlier attempt's error must not carry over onto
    // a retry that goes on to succeed (which otherwise ended up status "ok" with a stale error).
    error: undefined,
  });
  persistRun(rs.run);

  try {
    await invoke("flow_run_node", {
      runId: rs.run.id,
      nodeId,
      attempt,
      backend: backendOfModel(node.model),
      model: node.model ?? "",
      prompt,
      cwd,
      toolAllowlist: allowlist,
      permissionMode: modeFor(await rs.modes, nodeId),
    });
    // A cancel that raced this invoke — it was still pending when cancelRun ran,
    // so flow_cancel_run's session snapshot missed this node's just-spawned child. The child is
    // now guaranteed to be in Rust's session map (flow_run_node only resolves after insert), so
    // flow_cancel_node reaches it. Do not touch run/node state here: handleNodeEvent's
    // rs.canceled branch (and the eventual terminal "canceled" event this cancel produces) is
    // the only place that finishes the run, so it stays held until Rust confirms.
    if (rs.canceled || !liveRuns.has(rs.run.id)) {
      void invoke("flow_cancel_node", { runId: rs.run.id, nodeId }).catch(() => {});
    }
  } catch (err) {
    // A spawn error after a cancel must never overwrite run.status "canceled" with "error" —
    // cancelRun (or a terminal event already processed under it) already decided the run's fate.
    if (rs.canceled || !liveRuns.has(rs.run.id)) return;
    setNodeState(rs.run, nodeId, {
      status: "error",
      endedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
    persistRun(rs.run);
    finishRun(rs, "error");
  }
}

/** S.runOutputs (§4.1) feeds the run view's output tile. Mirrors every event that carries text, keyed
 *  `${runId}:${nodeId}:out:${attempt}`. */
function updateRunOutput(runId: string, nodeId: string, attempt: number, text: string, terminal: boolean): void {
  const key = `${runId}:${nodeId}:out:${attempt}`;
  const prev = S.runOutputs.get(key);
  const now = new Date().toISOString();
  S.runOutputs.set(key, {
    runId,
    nodeId,
    port: "out",
    attempt,
    text,
    truncated: text.startsWith("[truncated]"), // flow.rs's cap_text prefix, verified flow.rs:462
    startedAt: prev?.startedAt ?? now,
    endedAt: terminal ? now : undefined,
  });
}

function handleNodeEvent(event: FlowNodeEvent): void {
  const rs = liveRuns.get(event.runId);
  if (!rs) return;
  const run = rs.run;
  const node = rs.graph.nodes.find((n) => n.id === event.nodeId);
  if (!node) return;

  const terminal = event.status === "ok" || event.status === "error" || event.status === "canceled";

  if (rs.canceled) {
    // cancelRun already recorded the cancel and cleared approvals; it never
    // finishes the run itself so this run stays held (in liveRuns and runner-adapter's
    // heldRunIds) until the live node's own terminal event arrives here. That keeps the event
    // deliverable to every subscriber, including run-view.ts's independent one, which repaints
    // it — finishing eagerly in cancelRun would have marked the run unheld first and dropped
    // this same event before it ever reached a subscriber. advance()/retry never run once
    // canceled.
    if (!terminal) return;
    removePendingForNode(run.id, event.nodeId);
    // A run Cancel wins over a denial recorded for the same attempt (settleTerminal).
    const settled = settleTerminal({
      eventStatus: event.status as "ok" | "error" | "canceled",
      denied: rs.deniedAttempts.has(`${event.nodeId}:${event.attempt}`),
      runCanceled: true,
      canRetry: false,
    });
    setNodeState(run, event.nodeId, { status: settled.nodeStatus, endedAt: new Date().toISOString() });
    persistRun(run);
    finishRun(rs, settled.runStatus ?? "canceled");
    return;
  }

  if (event.status === "awaiting-approval" && event.permission) {
    S.pendingApprovals.set(event.permission.id, {
      runId: run.id,
      nodeId: event.nodeId,
      attempt: event.attempt,
      request: event.permission,
    });
    notifyPendingApprovalsChanged();
  }

  const prevCost = run.nodes[event.nodeId]?.costUsd;
  setNodeState(run, event.nodeId, {
    status: event.status,
    costUsd: event.costUsd !== undefined ? (prevCost ?? 0) + event.costUsd : prevCost,
    error: event.error ?? run.nodes[event.nodeId]?.error,
  });

  if (event.text !== undefined) updateRunOutput(run.id, event.nodeId, event.attempt, event.text, terminal);

  if (terminal) removePendingForNode(run.id, event.nodeId);

  if (!terminal) {
    persistRun(run);
    return;
  }

  // A denied attempt settles "denied" whatever terminal event the backend sends for it (Deny ends
  // the session through flow_cancel_node, so it is usually "canceled"), and stops the chain like
  // an error: no downstream node starts, never-started nodes stay "idle".
  // A denied attempt is never retried.
  const denied = rs.deniedAttempts.has(`${event.nodeId}:${event.attempt}`);
  const settled = settleTerminal({
    eventStatus: event.status as "ok" | "error" | "canceled",
    denied,
    runCanceled: false,
    canRetry: shouldRetry(event.attempt, addonValue(node, "retries"), event.status === "error"),
  });

  if (settled.step === "retry") {
    persistRun(run);
    void runNode(rs, event.nodeId, nextAttemptNumber(event.attempt));
    return;
  }

  const patch: Partial<FlowRunNodeState> = { status: settled.nodeStatus, endedAt: new Date().toISOString() };
  if (event.status === "ok") {
    // The persisted run record's own bounded copy of this
    // node's output (run.ts's FlowRunNodeState.summary), first 2000 chars, tail-truncated by the
    // slice like flow.rs's own OUTPUT_CAP_BYTES cap.
    patch.summary = (event.text ?? "").slice(0, 2000);
  }
  setNodeState(run, event.nodeId, patch);
  persistRun(run);

  if (settled.step === "advance") {
    // Capped event text (64 KiB, child.rs) is never what the next node gets: resolveHandoffText
    // reads the full file first. Uncapped text takes the synchronous path, no read.
    if (!(event.text ?? "").startsWith(OUTPUT_CAP_MARKER)) {
      rs.upstreamOutputs[event.nodeId] = event.text ?? "";
      advance(rs, event.nodeId);
      return;
    }
    void handOffFullOutput(rs, event);
    return;
  }
  finishRun(rs, settled.runStatus ?? "error");
}

/** Capped terminal text: read the full result before advancing. The node is already "ok" in the
 *  run record, so a cancel during the read finds no live attempt and finishes the run itself
 *  (cancelRun); this then sees `rs.canceled`/an unheld run and starts nothing. A failed read
 *  stops the chain with an error on the node rather than handing on the capped tail. */
async function handOffFullOutput(rs: RunEngineState, event: FlowNodeEvent): Promise<void> {
  const nodeId = event.nodeId;
  const handoff = await resolveHandoffText(event, () => invoke("flow_output_read", { runId: rs.run.id, nodeId }));
  if (rs.canceled || liveRuns.get(rs.run.id) !== rs) return;
  if (!handoff.ok) {
    setNodeState(rs.run, nodeId, { status: "error", error: handoff.error, endedAt: new Date().toISOString() });
    persistRun(rs.run);
    finishRun(rs, "error");
    return;
  }
  setNodeState(rs.run, nodeId, { summary: handoff.text.slice(0, 2000) });
  rs.upstreamOutputs[nodeId] = handoff.text;
  advance(rs, nodeId);
}

/** Deny ends the node (otherwise the agent retries the tool and asks again). Called by run-view.ts after `flow_answer_permission`
 *  has delivered the deny: cancels just this node's session through the existing cancel path
 *  (flow.rs's cancel_child: interrupt, close stdin, grace, job kill), whose terminal "canceled"
 *  event handleNodeEvent then settles "denied" via the attempt's deniedAttempts record. Not
 *  rs.canceled, so a later run Cancel still reports "canceled" and a Deny never does. */
export function endDeniedNode(runId: string, nodeId: string): void {
  if (!liveRuns.has(runId)) return;
  void invoke("flow_cancel_node", { runId, nodeId }).catch(() => {});
}

/** Final output of the last agent node in chain order, written onto the flow's `output` node as
 *  a `FlowRunNodeOutput` at port `in`, attempt 1 (§4.2: "the output node's content is stored...
 *  once the run completes"). */
function writeOutputNodeResult(rs: RunEngineState): void {
  const outputNode = rs.graph.nodes.find((n) => n.kind === "output");
  const lastAgentId = rs.chain[rs.chain.length - 1];
  if (!outputNode || !lastAgentId) return;
  const text = rs.upstreamOutputs[lastAgentId];
  if (text === undefined) return;
  const now = new Date().toISOString();
  S.runOutputs.set(`${rs.run.id}:${outputNode.id}:in:1`, {
    runId: rs.run.id,
    nodeId: outputNode.id,
    port: "in",
    attempt: 1,
    text,
    truncated: text.startsWith("[truncated]"),
    startedAt: now,
    endedAt: now,
  });
  // S.runOutputs is session-only (run.ts); the run record's `summary` is what a reloaded or
  // held run still has, so the output node carries it like any node that produced text.
  setNodeState(rs.run, outputNode.id, { summary: text.slice(0, 2000) });
}

/** The input/output boundary nodes never run an attempt of their own, so they stayed
 *  `status:"idle"` in `run.nodes` for the whole run, including a fully successful one. */
function markBoundaryNodesOk(rs: RunEngineState): void {
  const now = new Date().toISOString();
  for (const boundary of rs.graph.nodes) {
    if (boundary.kind !== "input" && boundary.kind !== "output") continue;
    setNodeState(rs.run, boundary.id, {
      status: "ok",
      startedAt: rs.run.nodes[boundary.id]?.startedAt ?? now,
      endedAt: now,
    });
  }
}

function advance(rs: RunEngineState, justFinishedNodeId: string): void {
  const idx = rs.chain.indexOf(justFinishedNodeId);
  const nextId = idx >= 0 ? rs.chain[idx + 1] : undefined;
  if (nextId) {
    void runNode(rs, nextId, 1);
    return;
  }
  writeAcademySuggestion(rs);
  writeOutputNodeResult(rs);
  markBoundaryNodesOk(rs);
  finishRun(rs, completedRunStatus(Object.values(rs.run.nodes).map((n) => n.status)));
}

/** §4.2/§2: written from the final output of the node whose `preset` field is `academy`, never
 *  by title. */
function writeAcademySuggestion(rs: RunEngineState): void {
  const academyNode = rs.graph.nodes.find(
    (n) => n.kind === "agent" && n.fields.find((f) => f.k === "preset")?.v === "academy",
  );
  if (!academyNode) return;
  const text = rs.upstreamOutputs[academyNode.id];
  if (text !== undefined) rs.run.academySuggestions = text;
}

function finishRun(rs: RunEngineState, status: FlowRunStatus): void {
  rs.run.status = status;
  rs.run.endedAt = new Date().toISOString();
  persistRun(rs.run);
  markRunUnheld(rs.run.id);
  liveRuns.delete(rs.run.id);
  lastPersistedSignature.delete(rs.run.id);
}

/** RUN click: deep-copies an editable graph into `FlowRun.graphSnapshot` (§4.1); a frozen
 *  control-approved graph is already the reviewed snapshot and keeps its identity. Starts the
 *  first agent node in chain order. Returns the new `FlowRun` (already
 *  persisted once, before any node starts). */
export function startRun(graph: FlowGraph, reserved = false, modes?: NodeModes): FlowRun {
  if (controlStartReserved && !reserved) throw new Error("flow busy");
  if (liveRuns.size > 0) throw new Error("flow busy");
  ensureAdapterSubscribed();
  const snapshot: FlowGraph = Object.isFrozen(graph) ? graph : JSON.parse(JSON.stringify(graph)) as FlowGraph;
  const chain = agentChain(snapshot);
  const now = new Date().toISOString();
  const nodes: Record<string, FlowRunNodeState> = {};
  for (const node of snapshot.nodes) nodes[node.id] = { nodeId: node.id, status: "idle", attempts: 0 };

  const run: FlowRun = {
    id: newRunId(),
    graphId: snapshot.id,
    graphSnapshot: snapshot,
    status: "running",
    startedAt: now,
    nodes,
  };
  const rs: RunEngineState = {
    run,
    graph: snapshot,
    chain,
    upstreamOutputs: {},
    canceled: false,
    deniedAttempts: new Set(),
    modes: modes ? Promise.resolve(modes) : resolveRunModes(snapshot),
  };
  liveRuns.set(run.id, rs);
  markRunHeld(run.id);
  persistRun(run);

  const first = chain[0];
  if (first) void runNode(rs, first, 1);
  else finishRun(rs, "success");

  return run;
}

/** runs-store.ts's `initRunsStore(heldRunIds)` reconciles every stored run still
 *  `status:"running"` that isn't in this set, canceling it — this avoids marking a
 *  run this same engine instance is still driving (a Flow panel close/reopen in one session)
 *  Interrupted and killing its live children out from under it. */
export function heldRunIds(): ReadonlySet<string> {
  return new Set(liveRuns.keys());
}

/** Cancels every live node of `runId` via `flow_cancel_run` (§4.3 step 6) and clears its pending
 *  approvals. Idempotent — a runId engine.ts no longer holds is a no-op past the (also idempotent)
 *  Rust call.
 *
 *  This must not mark every non-terminal node "canceled" and call finishRun
 *  right here, synchronously — before Rust had actually killed anything. That marked the run
 *  unheld immediately, so runner-adapter.ts dropped the real terminal "canceled" event the kill
 *  goes on to produce, for every subscriber, including run-view.ts's own independent one, which
 *  then never repainted the node and left it showing "running" forever. Only a node with no live
 *  attempt (never started, or already terminal) is safe to mark here; a queued/running/
 *  awaiting-approval node has, or is about to have (see runNode's own post-invoke check), a real
 *  Rust child, and is left for handleNodeEvent's `rs.canceled` branch to finish once that child's
 *  terminal event actually arrives — that is also what keeps the run held for run-view.ts to
 *  still see it. */
export function cancelRun(runId: string): void {
  const rs = liveRuns.get(runId);
  if (!rs) {
    void invoke("flow_cancel_run", { runId }).catch(() => {});
    return;
  }
  rs.canceled = true;

  // Clearing the entries left their rows on screen until the terminal
  // event repainted the whole run — repaint each affected node's queue (now empty) right away.
  const clearedNodeIds = new Set<string>();
  for (const [id, approval] of S.pendingApprovals) {
    if (approval.runId === runId) {
      S.pendingApprovals.delete(id);
      clearedNodeIds.add(approval.nodeId);
    }
  }
  if (clearedNodeIds.size) notifyPendingApprovalsChanged();
  for (const nodeId of clearedNodeIds) paintApprovalQueue(runId, nodeId);

  void invoke("flow_cancel_run", { runId }).catch(() => {});

  let hasLiveAttempt = false;
  for (const nodeId of Object.keys(rs.run.nodes)) {
    const state = rs.run.nodes[nodeId];
    if (state.status === "queued" || state.status === "running" || state.status === "awaiting-approval") {
      hasLiveAttempt = true;
    }
  }
  persistRun(rs.run);
  // No node ever started, or every node already reached a terminal status — there is nothing
  // for a Rust event to finish this run from, so end it now rather than never.
  if (!hasLiveAttempt) finishRun(rs, "canceled");
}
