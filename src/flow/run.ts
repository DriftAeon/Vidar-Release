// FLOW run types — engine.ts implements execution against these. The one piece of logic is
// resolveHandoffText (leaf, so `node --test` can drive it; engine.ts is not under test).

import type { FlowGraph } from "./model";

export type FlowRunNodeStatus =
  "idle" | "queued" | "running" | "awaiting-approval" | "ok" | "error" | "canceled" | "denied";
  // no "blocked": Execute is an ordinary sdk-backend node, so no armed-tab precondition exists.
  // "denied": engine-only — a node whose attempt had a tool call
  // denied at the approval row; Deny ends the attempt and stops the chain, whatever terminal
  // event flow.rs then sends for it. flow.rs never emits it (FlowNodeEventStatus).
/** Statuses flow.rs can put on a `flow-node-event`; "denied" is derived by engine.ts. */
type FlowNodeEventStatus = Exclude<FlowRunNodeStatus, "denied">;
/** "denied": a node was denied, which ends the run there (error wins in completedRunStatus; a
 *  canceled run stays canceled). */
export type FlowRunStatus = "running" | "success" | "error" | "canceled" | "denied";

interface FlowPermissionRequest {
  id: string;           // sidecar's permission_request id, verbatim
  toolUseId: string | null;
  tool: string;
  input: unknown;
  suggestions: unknown[];
}

export interface FlowRunNodeState {
  nodeId: string;
  status: FlowRunNodeStatus;
  startedAt?: string;
  endedAt?: string;
  costUsd?: number;      // total_cost_usd from the node's `result` message (SDK-cumulative
                          // per query, VERIFIED sdk.d.ts; a retried node sums per-attempt costs
                          // explicitly in engine.ts, never re-sums a single result)
  error?: string;        // "Interrupted" when a reload or restart orphaned the run (§4.1)
  attempts: number;      // 1-based count of attempts started; 1 unless the "retries" addon re-ran it
  denied?: boolean;      // a tool call was denied at the approval row during this node's run
  summary?: string;      // first 2000 chars of the node's final ("ok") output text (§4.1) — the
                          // persisted vidar.flow.runs.v1 record's only carried output text, so the
                          // cap-50 run list stays small; the full, unbounded text lives only in
                          // state.runOutputs, in-memory for the current session (never persisted)
}

// A frozen graph snapshot per run — edits to the live graph afterward never affect a
// run already started or finished. Together with FlowRunNodeOutput and renderPrompt (engine.ts) it forms the executable data
// contract.
export interface FlowRun {
  id: string;
  graphId: string;
  graphSnapshot: FlowGraph;          // deep copy taken at RUN click, before any node starts
  status: FlowRunStatus;
  startedAt: string;
  endedAt?: string;
  nodes: Record<string, FlowRunNodeState>;
  academySuggestions?: string;       // written by an Academy-preset node only; never mutates graphSnapshot or the live graph
}

/** One outstanding permission request, state.pendingApprovals' value (keyed by request.id). */
export interface FlowPendingApproval {
  runId: string;
  nodeId: string;
  attempt: number;
  request: FlowPermissionRequest;
}

// Bounded per-attempt output, addressable by run/node/port/attempt.
export interface FlowRunNodeOutput {
  runId: string; nodeId: string; port: string; attempt: number; // attempt 1-based
  text: string;        // node output text as defined in §4.3 step 4; past OUTPUT_CAP_BYTES (64 KiB)
                       // it keeps the TAIL and is prefixed "[truncated]…" (the end of a turn is
                       // where the answer is)
  truncated: boolean;
  costUsd?: number;
  startedAt: string;
  endedAt?: string;
}

/** Frontend-normalized event, one shape regardless of backend ("sdk" or "codex").
 *  Emitted by runner-adapter.ts from flow.rs's `flow-node-event` Tauri payload.
 *  runner-adapter.ts is a multi-subscriber hub — engine.ts (scheduling) and run-view.ts
 *  (painting) each register their own callback, unlike edges.ts's single-slot
 *  onSelectionChanged (VERIFIED edges.ts:13-17, one `let ... | null` ref). */
export interface FlowNodeEvent {
  runId: string;
  nodeId: string;
  attempt: number;                      // 1-based; runner-adapter.ts drops any event whose attempt is
                                        // not the node's current one (a cancelled/retried child still draining)
  status: FlowNodeEventStatus;
  text?: string;                       // this attempt's output text so far (§4.3 step 4), cumulative not a
                                        // delta, emitted at most 4 Hz per node plus once at the end
  costUsd?: number;
  error?: string;
  permission?: FlowPermissionRequest;   // present only on the event that opens a request (status
                                        // "awaiting-approval"); a node with several open requests
                                        // gets one such event per request
  /** Terminal events only: path of the file holding the node's full, uncapped final text, or
   *  null/absent when none was written (flow.rs always serializes the key, null on a failed write).
   *  `text` is capped at 64 KiB and starts with `[truncated]` when it was. */
  outputFile?: string | null;
  // reserved name, not a field in v1: `instance?: number` (v2 fan-out, several instances of one node)
}

/** Prefix flow's `cap_text` (child.rs) puts on event text it cut down to the cap. */
export const OUTPUT_CAP_MARKER = "[truncated]";

export type HandoffText = { ok: true; text: string } | { ok: false; error: string };

/** The text the next node must receive for a node's terminal "ok" event. Uncapped text is used
 *  as is (the fast path, no read). Capped text is replaced by the full file via `read`
 *  (`flow_output_read`); a missing file, an empty or failed read is an error, never a silent
 *  handoff of the capped tail. */
export async function resolveHandoffText(
  event: Pick<FlowNodeEvent, "text" | "outputFile">,
  read: () => Promise<string | null | undefined>,
): Promise<HandoffText> {
  const text = event.text ?? "";
  if (!text.startsWith(OUTPUT_CAP_MARKER)) return { ok: true, text };
  const fail = (why: string): HandoffText => ({
    ok: false,
    error: `Full output could not be read (${why}); the capped text was not passed on`,
  });
  if (!event.outputFile) return fail("no output file was written");
  try {
    const full = await read();
    if (typeof full !== "string" || full === "") return fail("the output file is empty or missing");
    return { ok: true, text: full };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
