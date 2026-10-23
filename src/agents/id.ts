// src\agents\id.ts — the one agent id type. Every "claude" | "codex" union in src aliases it.
// Type-only consumers stay erased at runtime, so the pure modules that import it keep loading
// under plain node.

export type AgentId = "claude" | "codex";
export const AGENT_IDS: readonly AgentId[] = ["claude", "codex"];
