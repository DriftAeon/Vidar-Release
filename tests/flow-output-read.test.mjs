// G: the inspector's full-output read (src/flow/output-read.ts). A slow read for a card that is no
// longer current must not fill the current one, and an Output node reads its source agent's file
// as wired in the executed run, not in the live graph.
import test from "node:test";
import assert from "node:assert/strict";
import { createOutputReader, outputReadTarget } from "../src/flow/output-read.ts";

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("output read: a slow read for an old (run, node, attempt) is dropped", async () => {
  const pending = new Map();
  const reader = createOutputReader((runId, nodeId) => {
    const d = deferred();
    pending.set(`${runId}:${nodeId}`, d);
    return d.promise;
  });
  const old = reader.load({ runId: "run-a", nodeId: "diagnose", attempt: 1 });
  const cur = reader.load({ runId: "run-a", nodeId: "review", attempt: 2 });
  pending.get("run-a:review").resolve("current text");
  pending.get("run-a:diagnose").resolve("old text");
  assert.equal(await cur, "current text");
  assert.equal(await old, undefined, "stale read filled the current card");

  // A rejected read (command absent) is "no full text", never a throw.
  const failing = createOutputReader(() => Promise.reject(new Error("unknown command")));
  assert.equal(await failing.load({ runId: "run-a", nodeId: "review", attempt: 1 }), undefined);
});

test("output read: an Output node resolves its source from the executed run's edges", () => {
  const edge = (from, to) => ({ id: `${from}-${to}`, from: { node: from, port: "out" }, to: { node: to, port: "in" } });
  const node = (id, kind) => ({ id, kind, title: id, x: 0, y: 0, fields: [], inputs: ["in"], outputs: ["out"] });
  const run = {
    id: "run-a",
    graphId: "g",
    status: "success",
    startedAt: "2026-10-02T10:00:00.000Z",
    // Executed wiring: review -> output. The live graph may since have rewired output to diagnose.
    graphSnapshot: {
      id: "g", name: "g", updatedAt: "2026-10-02T10:00:00.000Z",
      nodes: [node("input", "input"), node("diagnose", "agent"), node("review", "agent"), node("output", "output")],
      edges: [edge("input", "diagnose"), edge("diagnose", "review"), edge("review", "output")],
    },
    nodes: {
      diagnose: { nodeId: "diagnose", status: "ok", attempts: 1 },
      review: { nodeId: "review", status: "ok", attempts: 2 },
      output: { nodeId: "output", status: "ok", attempts: 0 },
    },
  };
  assert.deepEqual(outputReadTarget(run, "output"), { runId: "run-a", nodeId: "review", attempt: 2 });
  assert.deepEqual(outputReadTarget(run, "diagnose"), { runId: "run-a", nodeId: "diagnose", attempt: 1 });
  run.nodes.review.status = "error";
  assert.equal(outputReadTarget(run, "output"), null, "an unfinished source has no final text to read");
});
