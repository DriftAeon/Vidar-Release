// Launcher identity is separate from the CLI driving the tab and its controls.
import type { SessionAgent } from "../panels/sessions/types";
// Gateway ids are the present gateway modules (agent.gateway, launcher/gateways.ts writes them on
// every module change). Kept as a plain set so this file stays free of runtime imports.
let gatewayIds: ReadonlySet<string> = new Set();
export function setGatewayIds(ids: Iterable<string>): void {
  gatewayIds = new Set(ids);
}

export function isGateway(id: string | undefined): boolean {
  return id !== undefined && gatewayIds.has(id);
}

export function agentKind(id: string): SessionAgent {
  if (isGateway(id)) return "claude";
  return id === "claude" || id === "codex" || id === "gemini" || id === "pi" ? id : "shell";
}

// Gateway Falcon launches now share the vendor wrapper's checked preparation.
export function canRenderAgent(kind: SessionAgent, _art?: string): boolean {
  return kind === "claude" || kind === "codex";
}
