// Launcher identity is separate from the CLI driving the tab and its controls.
import type { SessionAgent } from "../panels/sessions/types";
// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { AGENT_IDS, PTY_ONLY_IDS, isAgentId, type AgentId } from "../agents/id.ts";
// Gateway ids are the present gateway modules (agent.gateway, launcher/gateways.ts writes them on
// every module change). Kept as a plain set so this file stays free of runtime imports.
let gatewayIds: ReadonlySet<string> = new Set();
const GATEWAY_HOST: Record<AgentId, boolean> = { claude: true, codex: false };
const gatewayKind: AgentId = AGENT_IDS.find((id) => GATEWAY_HOST[id]) ?? (() => { throw new Error("Gateway host agent missing"); })();
export const gatewayAgent: AgentId = gatewayKind;
export function setGatewayIds(ids: Iterable<string>): void {
  gatewayIds = new Set(ids);
}

export function isGateway(id: string | undefined): boolean {
  return id !== undefined && gatewayIds.has(id);
}

export function agentKind(id: string): SessionAgent {
  if (isGateway(id)) return gatewayKind;
  if (isAgentId(id)) return id;
  return (PTY_ONLY_IDS as readonly string[]).includes(id) ? id as typeof PTY_ONLY_IDS[number] : "shell";
}

// Gateway Falcon launches now share the vendor wrapper's checked preparation.
export function canRenderAgent(kind: SessionAgent, _art?: string): boolean {
  return isAgentId(kind);
}
