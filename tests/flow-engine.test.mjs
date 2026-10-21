// Adapter+Engine acceptance. Imports
// render.ts and topo.ts only — both leaf modules; engine.ts and
// runner-adapter.ts are wiring, not under `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { topoSort } from "../src/flow/topo.ts";
import {
  renderPrompt,
  maxAttempts,
  shouldRetry,
  nextAttemptNumber,
  PLACEHOLDER_RE,
  terminalNodeStatus,
  completedRunStatus,
  settleTerminal,
} from "../src/flow/render.ts";

function node(id, task, addons) {
  return {
    id,
    kind: "agent",
    title: id,
    x: 0,
    y: 0,
    model: "claude-sonnet-5",
    fields: [{ k: "task", v: task }],
    inputs: ["in"],
    outputs: ["out"],
    ...(addons ? { addons } : {}),
  };
}

// --- topo.ts: order on a straight chain ---

test("topoSort: straight chain a -> b -> c -> d", () => {
  const order = topoSort(
    ["d", "a", "c", "b"],
    [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ],
  );
  assert.deepEqual(order, ["a", "b", "c", "d"]);
});

test("topoSort: returns null on a cycle", () => {
  const order = topoSort(
    ["a", "b"],
    [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
  );
  assert.equal(order, null);
});

test("topoSort: ignores edges naming an unknown id", () => {
  const order = topoSort(
    ["a", "b"],
    [
      { from: "a", to: "b" },
      { from: "b", to: "ghost" },
    ],
  );
  assert.deepEqual(order, ["a", "b"]);
});

// --- render.ts: renderPrompt default-append vs. explicit placeholder ---

test("renderPrompt: zero placeholders on the first agent node appends the input node's content", () => {
  const n = node("plan", "Make a plan.");
  const out = renderPrompt({ node: n, chain: ["plan"], inputContent: "Ship the thing", upstreamOutputs: {} });
  assert.equal(out, "Make a plan.\n\n---\nUpstream output:\nShip the thing");
});

test("renderPrompt: zero placeholders on a later node appends its predecessor's output, not the input", () => {
  const n = node("review", "Review the plan.");
  const out = renderPrompt({
    node: n,
    chain: ["plan", "review"],
    inputContent: "Ship the thing",
    upstreamOutputs: { plan: "1. Do X\n2. Do Y" },
  });
  assert.equal(out, "Review the plan.\n\n---\nUpstream output:\n1. Do X\n2. Do Y");
});

test("renderPrompt: explicit placeholder substitutes only the named ref, no implicit append", () => {
  const n = node("review", "Review {{plan}} against {{input}}.");
  const out = renderPrompt({
    node: n,
    chain: ["plan", "review"],
    inputContent: "the brief",
    upstreamOutputs: { plan: "1. Do X" },
  });
  assert.equal(out, "Review 1. Do X against the brief.");
});

test("renderPrompt: single-pass substitution never re-expands a placeholder-shaped upstream output", () => {
  const n = node("review", "Review {{plan}}.");
  const out = renderPrompt({
    node: n,
    chain: ["plan", "review"],
    inputContent: "",
    upstreamOutputs: { plan: "contains {{input}} literally" },
  });
  assert.equal(out, "Review contains {{input}} literally.");
});

test("renderPrompt: system-prompt addon prefixes with a blank-line separator", () => {
  const n = node("plan", "Make a plan.", [{ kind: "system-prompt", label: "System prompt", value: "You are terse." }]);
  const out = renderPrompt({ node: n, chain: ["plan"], inputContent: "Ship it", upstreamOutputs: {} });
  assert.equal(out, "You are terse.\n\nMake a plan.\n\n---\nUpstream output:\nShip it");
});

test("renderPrompt: structured input content (JSON text) is inserted as-is", () => {
  const n = node("plan", "Use {{input}}.");
  const json = JSON.stringify({ a: 1, b: [2, 3] });
  const out = renderPrompt({ node: n, chain: ["plan"], inputContent: json, upstreamOutputs: {} });
  assert.equal(out, `Use ${json}.`);
});

// --- shared placeholder case table (mirrors validate.ts's own copy of the §4.2 regex) ---

const PLACEHOLDER_CASES = [
  ["{{input}}", ["input"]],
  ["{{plan}}", ["plan"]],
  ["no placeholder here", []],
  ["{{a}} and {{b-2}} and {{c_3}}", ["a", "b-2", "c_3"]],
  ["{{Invalid}}", []], // uppercase not in the node-id charset — not a match
  ["{{}}", []], // empty ref never matches
];

test("render.ts's PLACEHOLDER_RE matches the shared case table", () => {
  for (const [text, expected] of PLACEHOLDER_CASES) {
    PLACEHOLDER_RE.lastIndex = 0;
    const found = [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
    assert.deepEqual(found, expected, `case: ${text}`);
  }
});

// --- retry policy and 1-based attempt numbering ---

test("maxAttempts: retries addon clamps 0-2 extra attempts, hard cap 3 total", () => {
  assert.equal(maxAttempts(undefined), 1);
  assert.equal(maxAttempts("0"), 1);
  assert.equal(maxAttempts("1"), 2);
  assert.equal(maxAttempts("2"), 3);
  assert.equal(maxAttempts("5"), 3);
  assert.equal(maxAttempts("-1"), 1);
  assert.equal(maxAttempts("nope"), 1);
});

test("shouldRetry: retries only on failure, and only under the cap", () => {
  assert.equal(shouldRetry(1, "2", false), false); // not failed -> never retry
  assert.equal(shouldRetry(1, "2", true), true); // attempt 1 of 3 max -> retry
  assert.equal(shouldRetry(2, "2", true), true); // attempt 2 of 3 max -> retry
  assert.equal(shouldRetry(3, "2", true), false); // attempt 3 of 3 max -> no more retries
  assert.equal(shouldRetry(1, undefined, true), false); // default 0 extra -> no retry
});

// --- denied: a tool call denied at the approval row ---

test("denied then clean exit: node and run are denied", () => {
  const nodeStatus = terminalNodeStatus("ok", true);
  assert.equal(nodeStatus, "denied");
  // input/output boundary nodes are marked ok by markBoundaryNodesOk before finishRun
  assert.equal(completedRunStatus(["ok", nodeStatus, "ok"]), "denied");
});

test("completedRunStatus: error wins over denied", () => {
  assert.equal(completedRunStatus(["ok", "error"]), "error");
  assert.equal(completedRunStatus(["denied", "error"]), "error");
});

test("no denial: clean exit stays ok, run success; error and cancel stay what they were", () => {
  assert.equal(terminalNodeStatus("ok", false), "ok");
  assert.equal(terminalNodeStatus("error", false), "error");
  assert.equal(terminalNodeStatus("canceled", false), "canceled");
  assert.equal(completedRunStatus(["ok", "ok"]), "success");
});

// --- denial stops the chain; Deny ends the node ---

test("settleTerminal: a denied node stops the chain and finishes the run denied", () => {
  const s = settleTerminal({ eventStatus: "ok", denied: true, runCanceled: false, canRetry: false });
  assert.deepEqual(s, { nodeStatus: "denied", step: "finish", runStatus: "denied" });
  assert.notEqual(s.step, "advance"); // no downstream node starts
});

test("settleTerminal: deny then backend canceled/error for the same attempt still settles denied", () => {
  // Deny ends the session through flow_cancel_node, so flow.rs's terminal event is "canceled";
  // a crash on the way down arrives as "error" — the denial record wins for that attempt, and a
  // denied attempt is never retried even when the retries addon would allow it.
  for (const eventStatus of ["canceled", "error"]) {
    const s = settleTerminal({ eventStatus, denied: true, runCanceled: false, canRetry: true });
    assert.deepEqual(s, { nodeStatus: "denied", step: "finish", runStatus: "denied" }, eventStatus);
  }
});

test("settleTerminal: a run Cancel still yields canceled, even after a denial", () => {
  for (const denied of [false, true]) {
    for (const eventStatus of ["ok", "error", "canceled"]) {
      const s = settleTerminal({ eventStatus, denied, runCanceled: true, canRetry: true });
      assert.deepEqual(s, { nodeStatus: "canceled", step: "finish", runStatus: "canceled" }, `${eventStatus}/${denied}`);
    }
  }
});

test("settleTerminal: without a denial, ok advances, error retries or finishes, canceled finishes", () => {
  assert.deepEqual(settleTerminal({ eventStatus: "ok", denied: false, runCanceled: false, canRetry: false }), { nodeStatus: "ok", step: "advance" });
  assert.deepEqual(settleTerminal({ eventStatus: "error", denied: false, runCanceled: false, canRetry: true }), { nodeStatus: "error", step: "retry" });
  assert.deepEqual(settleTerminal({ eventStatus: "error", denied: false, runCanceled: false, canRetry: false }), { nodeStatus: "error", step: "finish", runStatus: "error" });
  assert.deepEqual(settleTerminal({ eventStatus: "canceled", denied: false, runCanceled: false, canRetry: false }), { nodeStatus: "canceled", step: "finish", runStatus: "canceled" });
});

test("nextAttemptNumber: 1-based increment", () => {
  assert.equal(nextAttemptNumber(1), 2);
  assert.equal(nextAttemptNumber(2), 3);
});
