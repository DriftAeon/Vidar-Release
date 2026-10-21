// Flow runner choice: which backend runs a node is derived from its model, never stored on the
// node. Pure leaf (no registry, no prefs) so `node --test` can import it; roster.ts feeds it the
// model -> backend map. The strings are flow.rs's `flow_run_node` arms, pinned by
// tests/flow-runner.test.mjs.

/** `"sdk"` = the Claude sidecar, `"codex"` = the Codex app-server (flow.rs). */
export type FlowBackend = "sdk" | "codex";

/** The Codex model id that sends no `model` on `thread/start` (flow/codex.rs `DEFAULT_MODEL`). */
export const CODEX_DEFAULT_MODEL = "codex-default";

/** A gateway or core `runner` name -> its Flow backend; null for a runner Flow cannot drive. */
export function backendOfRunner(runner: string | undefined): FlowBackend | null {
  if (runner === "claude") return "sdk";
  if (runner === "codex") return "codex";
  return null;
}

let lookup: (model: string) => FlowBackend | undefined = () => undefined;

/** roster.ts hands in the live model -> backend lookup (read per call, so a saved Codex model
 *  list that changes later is seen). */
export function setBackendLookup(fn: (model: string) => FlowBackend | undefined): void {
  lookup = fn;
}

/** The backend for a model id; an id the roster does not know runs on the Claude sidecar, as
 *  every node did before the Codex runner. */
export function backendOfModel(model: string | undefined): FlowBackend {
  return (model && lookup(model)) || "sdk";
}
