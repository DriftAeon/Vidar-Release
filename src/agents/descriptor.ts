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
  /** the project instructions file name (agent_spec.rs `instructions_file`) */
  instructionsFile: string;
  /** the per-user folder under the home directory (`user_dir`; not the Bare home's config folder) */
  userDir: string;
  /** the env var naming the agent's home (protocol/agent_env.rs `home_env`) */
  homeEnv: string;
  /** the prefix of the agent's model ids, null when it has none (`model_prefix`) */
  modelPrefix: string | null;
  /** Flow's backend word (flow/bare.rs `backend_of`). */
  flowBackend: "sdk" | "codex";
  /** This agent runs through the Claude SDK sidecar. */
  flowSdk: boolean;
}

export const AGENTS: Readonly<Record<AgentId, AgentDescriptor>> = {
  claude: {
    id: "claude", name: "Claude", product: "Claude Code", art: "claude", modelPref: "claudeModels",
    instructionsFile: "CLAUDE.md", userDir: ".claude", homeEnv: "CLAUDE_CONFIG_DIR", modelPrefix: "claude-",
    flowBackend: "sdk", flowSdk: true,
  },
  codex: {
    id: "codex", name: "Codex", product: "Codex", art: "codex", modelPref: "codexModels",
    instructionsFile: "AGENTS.md", userDir: ".codex", homeEnv: "CODEX_HOME", modelPrefix: null,
    flowBackend: "codex", flowSdk: false,
  },
} satisfies Record<AgentId, AgentDescriptor>;

export { isAgentId };

/** Primary first (when given), then the rest in AGENT_IDS order. */
export function agentOrder(primary: AgentId | null): AgentId[] {
  return primary === null ? [...AGENT_IDS] : [primary, ...AGENT_IDS.filter((id) => id !== primary)];
}
