// The permission mode each agent node runs in, resolved once per run so the Run Flow card and the
// spawn read one value. Pure leaf: the IPC call is passed in (engine.ts hands it `flow_node_permissions`).
// Value imports are avoided so `node --test` can load this file.
import type { FlowGraph, PermissionMode } from "./model";

/** Node id -> the mode that node spawns in. */
export type NodeModes = Record<string, PermissionMode>;

const MODES: readonly PermissionMode[] = ["default", "acceptEdits", "auto"];

function asMode(value: unknown): PermissionMode {
  return MODES.find((mode) => mode === value) ?? "default";
}

/** What approval binds for one agent node (`flow_node_permissions`): the vault, the mode it spawns in,
 *  the vault's exact allow entries and the hash `flow_run_node` is handed back as `vaultHash`. */
export interface NodeGrant { vault: string; mode: PermissionMode; allow: string[]; hash: string }

/** Node id -> its grant; resolved once per run so the Run Flow card and the spawn read one value. */
export type NodeGrants = Record<string, NodeGrant>;

export interface NodeAsk { node: string; model: string; vault?: string; agent: string }

/** One grant per agent node. `agentOf` maps a node's backend to its agent id (the caller passes the
 *  `src/agents/id.ts` ids); a refused vault rejects, so a run never starts on an unapproved vault. */
export async function resolveNodeGrants(
  graph: FlowGraph,
  ask: (nodes: NodeAsk[]) => Promise<Array<{ node: string; vault: string; mode: string; allow: string[]; hash: string }>>,
  agentOf: (model: string | undefined) => string,
): Promise<NodeGrants> {
  const agents = graph.nodes.filter((node) => node.kind === "agent");
  const asks: NodeAsk[] = agents.map((node) => ({
    node: node.id, model: node.model ?? "", agent: agentOf(node.model), ...(node.vault ? { vault: node.vault } : {}),
  }));
  const answers = asks.length ? await ask(asks) : [];
  const grants: NodeGrants = {};
  for (const answer of answers) grants[answer.node] = { vault: answer.vault, mode: asMode(answer.mode), allow: answer.allow, hash: answer.hash };
  return grants;
}

/** The mode per node out of the grants (what the card's Permission Mode row reads). */
export function modesOfGrants(grants: NodeGrants | undefined): NodeModes {
  const modes: NodeModes = {};
  for (const [id, grant] of Object.entries(grants ?? {})) modes[id] = grant.mode;
  return modes;
}
