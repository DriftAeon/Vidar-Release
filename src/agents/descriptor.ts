// src\agents\descriptor.ts — what names an agent and draws its tab: one row per AgentId. `AGENTS`
// is `satisfies Record<AgentId, …>`, so a third id fails tsc until its row is written. The only
// runtime import is id.ts (`.ts` suffix), so `node --test` loads this file directly.

// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { AGENT_IDS, isAgentId } from "./id.ts";
import type { AgentId } from "./id.ts";

export interface AgentDescriptor {
  id: AgentId;
  /** "Claude", "Codex": pickers, notices, hosted rows */
  name: string;
  /** "Claude Code", "Codex": the Rendered start pill */
  product: string;
  /** tab art of a plain session ("claude", "codex") */
  art: string;
  modelPref: "claudeModels" | "codexModels";
}

export const AGENTS: Readonly<Record<AgentId, AgentDescriptor>> = {
  claude: { id: "claude", name: "Claude", product: "Claude Code", art: "claude", modelPref: "claudeModels" },
  codex: { id: "codex", name: "Codex", product: "Codex", art: "codex", modelPref: "codexModels" },
} satisfies Record<AgentId, AgentDescriptor>;

export { isAgentId };

/** Primary first (when given), then the rest in AGENT_IDS order. */
export function agentOrder(primary: AgentId | null): AgentId[] {
  return primary === null ? [...AGENT_IDS] : [primary, ...AGENT_IDS.filter((id) => id !== primary)];
}
