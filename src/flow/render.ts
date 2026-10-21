// Deterministic prompt rendering + retry policy. Leaf module (only `import type` from model.ts,
// so it stays importable under `node --test`'s extensionless resolution)
// — no DOM, no S, no scheduleSave. engine.ts is the only wiring caller.

import type { FlowNode } from "./model";

/** Mirrors §4.2's frozen placeholder regex — render.ts's own copy, since leaf modules cannot
 *  import each other under `node --test` (validate.ts restates the same pattern; both
 *  tests run one shared case table per §4.2). */
export const PLACEHOLDER_RE = /\{\{([a-z0-9_-]+)\}\}/g;

function fieldValue(node: FlowNode, k: string): string {
  return node.fields.find((f) => f.k === k)?.v ?? "";
}

function findPlaceholders(task: string): string[] {
  const refs: string[] = [];
  // PLACEHOLDER_RE is a module-level `g` regex — reset lastIndex before each scan so two calls
  // in the same tick (validate.ts-style reuse) never skip a match from a stale offset.
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(task)) !== null) refs.push(m[1]);
  return refs;
}

/** Single-pass substitution: each `{{ref}}` in `task` is replaced by its resolved text exactly
 *  once, so an upstream output that itself contains `{{x}}` is inserted literally, never
 *  expanded (§4.2 frozen spec). `resolve` returns the empty string for a `{{ref}}` this pass
 *  doesn't have a value for — render.ts trusts validate.ts to have already rejected an
 *  unresolvable ref before RUN is ever reachable, and never throws on one itself. */
function substitute(task: string, resolve: (ref: string) => string): string {
  PLACEHOLDER_RE.lastIndex = 0;
  return task.replace(PLACEHOLDER_RE, (_whole, ref: string) => resolve(ref));
}

/** §4.2's default-append block, used when `task` has zero placeholders. */
function withDefaultAppend(task: string, upstreamText: string): string {
  return `${task}\n\n---\nUpstream output:\n${upstreamText}`;
}

export interface RenderPromptArgs {
  node: FlowNode;
  /** Agent-node ids in this run's execution order (v1: the single straight chain) — used only to
   *  find `node`'s immediate predecessor for the default-append case; the predecessor's output
   *  itself comes from `upstreamOutputs`/`inputContent`, never recomputed here. */
  chain: string[];
  /** The flow's `input` node's `content` field — a `structured` input's JSON text is passed
   *  through as-is (already validated to parse, §4.2), inserted verbatim either way. */
  inputContent: string;
  /** Upstream agent nodes' final output text, keyed by node id, this attempt's chain only. */
  upstreamOutputs: Record<string, string>;
}

/** Pure function: renders one agent node's task text into the prompt sent to the sidecar.
 *  §4.2 frozen spec: placeholder substitution (explicit) vs. default-append (implicit), then the
 *  `system-prompt` addon's text prefixed with a blank-line separator. */
export function renderPrompt(args: RenderPromptArgs): string {
  const { node, chain, inputContent, upstreamOutputs } = args;
  const task = fieldValue(node, "task");
  const refs = findPlaceholders(task);

  let rendered: string;
  if (refs.length === 0) {
    const idx = chain.indexOf(node.id);
    const predecessorId = idx > 0 ? chain[idx - 1] : null;
    const upstreamText = predecessorId ? (upstreamOutputs[predecessorId] ?? "") : inputContent;
    rendered = withDefaultAppend(task, upstreamText);
  } else {
    rendered = substitute(task, (ref) => (ref === "input" ? inputContent : (upstreamOutputs[ref] ?? "")));
  }

  const systemPrompt = node.addons?.find((a) => a.kind === "system-prompt")?.value;
  return systemPrompt ? `${systemPrompt}\n\n${rendered}` : rendered;
}

/** §4.2: `retries` addon value ("0"–"2") = extra attempts beyond the first, hard cap 3 attempts
 *  total. Malformed/out-of-range values (missing addon, non-numeric, negative, >2) clamp to 0
 *  extra attempts rather than throwing — validate.ts is the gate that rejects a bad `retries`
 *  value before RUN, this is just a safe fallback. */
export function maxAttempts(retriesValue: string | undefined): number {
  const n = Number(retriesValue);
  const extra = Number.isInteger(n) && n >= 0 ? Math.min(n, 2) : 0;
  return 1 + extra;
}

/** A retry happens only when the attempt's `result` had `is_error: true`, or the process exited
 *  with no `result` at all (`failed`) — never after a cancel or a denied permission; engine.ts's
 *  caller is responsible for never invoking this on those paths (§4.2 frozen spec). */
export function shouldRetry(attempt: number, retriesValue: string | undefined, failed: boolean): boolean {
  return failed && attempt < maxAttempts(retriesValue);
}

/** A node's final status from its attempt's terminal event: once a
 *  tool call of the attempt was denied at the approval row, the attempt is "denied" whatever
 *  terminal event the backend sends for it — Deny ends the node's session (engine.ts's
 *  endDeniedNode), so that event is usually "canceled", occasionally "ok" or "error". */
export function terminalNodeStatus(
  eventStatus: "ok" | "error" | "canceled",
  denied: boolean,
): "ok" | "error" | "canceled" | "denied" {
  return denied ? "denied" : eventStatus;
}

/** What engine.ts does with a node's terminal event. `runCanceled` (the user's run Cancel) wins
 *  over everything, then a denial, then the event itself. "denied" stops the chain like "error":
 *  no downstream node starts, the run finishes right away, never-started nodes stay "idle". */
export interface TerminalSettlement {
  nodeStatus: "ok" | "error" | "canceled" | "denied";
  step: "advance" | "retry" | "finish";
  runStatus?: "error" | "canceled" | "denied"; // set when step is "finish"
}

export function settleTerminal(opts: {
  eventStatus: "ok" | "error" | "canceled";
  denied: boolean;
  runCanceled: boolean;
  canRetry: boolean; // shouldRetry(...) for this attempt; only consulted for a non-denied error
}): TerminalSettlement {
  if (opts.runCanceled) return { nodeStatus: "canceled", step: "finish", runStatus: "canceled" };
  const nodeStatus = terminalNodeStatus(opts.eventStatus, opts.denied);
  switch (nodeStatus) {
    case "ok":
      return { nodeStatus, step: "advance" };
    case "error":
      return opts.canRetry ? { nodeStatus, step: "retry" } : { nodeStatus, step: "finish", runStatus: "error" };
    case "canceled":
    case "denied":
      return { nodeStatus, step: "finish", runStatus: nodeStatus };
  }
}

/** Run status once the chain has run to its end: error wins over denied, denied over success.
 *  Cancel never reaches here (engine.ts finishes a canceled run on its own path); since a denied
 *  node now finishes the run itself (settleTerminal), "denied" is a guard here, not a path. */
export function completedRunStatus(nodeStatuses: Iterable<string>): "success" | "error" | "denied" {
  let denied = false;
  for (const s of nodeStatuses) {
    if (s === "error") return "error";
    if (s === "denied") denied = true;
  }
  return denied ? "denied" : "success";
}

/** Attempts are 1-based everywhere (events, outputs, `FlowRunNodeState.attempts`, §2). */
export function nextAttemptNumber(attempt: number): number {
  return attempt + 1;
}
