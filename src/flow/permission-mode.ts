// The permission mode each agent node runs in, resolved once per run so the Run Flow card and the
// spawn read one value. Pure leaf: the IPC call is passed in (engine.ts hands it `flow_permission_modes`).
// Value imports are avoided so `node --test` can load this file.
import type { FlowGraph, PermissionMode } from "./model";

/** Node id -> the mode that node spawns in. */
export type NodeModes = Record<string, PermissionMode>;

const MODES: readonly PermissionMode[] = ["default", "acceptEdits", "auto"];

function asMode(value: unknown): PermissionMode {
  return MODES.find((mode) => mode === value) ?? "default";
}

/** One mode per agent node. Codex nodes and any failed lookup read as `default`. */
export async function resolveNodeModes(
  graph: FlowGraph, ask: (models: string[]) => Promise<Record<string, string>>,
  backendOf: (model: string | undefined) => string,
): Promise<NodeModes> {
  const agents = graph.nodes.filter((node) => node.kind === "agent");
  const claude = [...new Set(agents.filter((node) => backendOf(node.model) === "sdk").map((node) => node.model ?? ""))];
  let byModel: Record<string, string> = {};
  try { byModel = claude.length ? await ask(claude) : {}; } catch { byModel = {}; }
  const modes: NodeModes = {};
  for (const node of agents) modes[node.id] = backendOf(node.model) === "sdk" ? asMode(byModel[node.model ?? ""]) : "default";
  return modes;
}

/** The mode for a node; the card and the spawn both read through here. */
export function modeFor(modes: NodeModes | undefined, nodeId: string): PermissionMode {
  return asMode(modes?.[nodeId]);
}
