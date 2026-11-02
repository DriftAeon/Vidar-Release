// Flow runner choice: which backend runs a node is derived from its model, never stored on the
// node. Pure leaf (no registry, no prefs) so `node --test` can import it; roster.ts feeds it the
// model -> backend map. The strings are flow.rs's `flow_run_node` arms, pinned by
// tests/flow-runner.test.mjs.

// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { AGENT_IDS } from "../agents/id.ts";
// @ts-ignore TS5097: node --test imports this leaf module directly
import { AGENTS } from "../agents/descriptor.ts";
import type { AgentId } from "../agents/id";

/** `"sdk"` = the Claude sidecar, `"codex"` = the Codex app-server (flow.rs). */
export type FlowBackend = (typeof AGENTS)[AgentId]["flowBackend"];

/** The Codex model id that sends no `model` on `thread/start` (flow/codex.rs `DEFAULT_MODEL`). */
export const CODEX_DEFAULT_MODEL = "codex-default";

/** Core model for the app-server backend, shared with the roster and validator. */
export function appServerDefaultModel(): string {
  return CODEX_DEFAULT_MODEL;
}

/** A gateway or core `runner` name -> its Flow backend; null for a runner Flow cannot drive. */
export function backendOfRunner(runner: string | undefined): FlowBackend | null {
  const agent = AGENT_IDS.find((id) => id === runner);
  return agent ? AGENTS[agent].flowBackend : null;
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
  return (model && lookup(model)) || AGENTS[sdkAgent()].flowBackend;
}

/** The one SDK agent is a descriptor capability, independent of AGENT_IDS order. */
export function sdkAgent(): AgentId {
  const id = AGENT_IDS.find((agent) => AGENTS[agent].flowSdk);
  if (!id) throw new Error("No Flow SDK agent");
  return id;
}

/** The agent assigned to a backend word. An unknown backend throws. */
export function agentOfBackend(backend: string): AgentId {
  const agent = AGENT_IDS.find((id) => AGENTS[id].flowBackend === backend);
  if (!agent) throw new Error(`Unknown Flow backend: ${backend}`);
  return agent;
}

/** The agent a model's node runs on. */
export function agentOfModel(model: string | undefined): AgentId {
  return agentOfBackend(backendOfModel(model));
}
