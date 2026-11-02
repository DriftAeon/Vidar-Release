// src\agents\id.ts — the one agent id type. Every "claude" | "codex" union in src aliases it.
// Type-only consumers stay erased at runtime, so the pure modules that import it keep loading
// under plain node.

export const AGENT_IDS = ["claude", "codex"] as const;
export type AgentId = typeof AGENT_IDS[number];

/** Agents that only ever run as PTY tabs; never members of AGENT_IDS. */
export const PTY_ONLY_IDS = ["pi"] as const;

/** Vendor names that stand for an agent id in identifiers and strings (the agent-key scanner reads them). */
export const VENDOR_ALIASES = { anthropic: "claude", openai: "codex" } as const satisfies Record<string, AgentId>;

/** Exhaustiveness guard: a `switch` over AgentId ends `default: return unknownAgent(a)`. */
export function unknownAgent(a: never): never {
  throw new Error(`Unknown agent: ${String(a)}`);
}

/** True for a string that names a full agent (a string boundary: Falcon summaries, vidar.json). */
export function isAgentId(x: unknown): x is AgentId {
  return typeof x === "string" && (AGENT_IDS as readonly string[]).includes(x);
}
