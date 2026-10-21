// Pure projection and wait seam. The subscriber is attached before checking state.
import type { FlowRun } from "./run";
import type { FlowGraph, FlowNode } from "./model";

export function flowStatusLine(run: FlowRun, root: string, orderedNodes: (graph: FlowGraph) => FlowNode[]): string {
  const nodes = orderedNodes(run.graphSnapshot).map((node) => ({
    id: node.id, status: run.nodes[node.id]?.status ?? "idle", summary: run.nodes[node.id]?.summary ?? "",
    output_file: `${root}\\runs\\${run.id}\\${node.id}.md`,
  }));
  return JSON.stringify({ run_id: run.id, status: run.status, nodes });
}

export function waitForFlow(
  runId: string, timeoutMs: number, get: (id: string) => FlowRun | undefined,
  subscribe: (cb: () => void) => () => void, signal?: AbortSignal,
  timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis,
): Promise<FlowRun | "timeout" | "gone" | "missing"> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    let unsubscribe = () => {};
    const finish = (result: FlowRun | "timeout" | "gone" | "missing") => {
      if (done) return;
      done = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", gone);
      resolve(result);
    };
    const check = () => {
      const run = get(runId);
      if (!run) finish("missing");
      else if (run.status !== "running") finish(run);
    };
    const gone = () => finish("gone");
    unsubscribe = subscribe(check);
    if (done) unsubscribe();
    if (done) return;
    check();
    if (done) return;
    signal?.addEventListener("abort", gone, { once: true });
    if (signal?.aborted) { gone(); return; }
    timer = timers.setTimeout(() => finish("timeout"), Math.max(1000, Math.min(3_600_000, timeoutMs)));
  });
}
