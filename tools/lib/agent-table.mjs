// Node reader for the agent table (src/agents/descriptor.ts): one import seam for tools that list agents.
// Usage: import { agentRows, agentIds } from "../lib/agent-table.mjs"; agentRows() -> AgentDescriptor[] in table order.
// Not a second table: it only loads descriptor.ts. A release-shape copy of tools/ ships without src/, so the load is
// guarded (same as tools/lib/paths.mjs) and a caller that needs the table gets a clear error instead of an import crash.
let table = null;
try {
  // @ts-ignore TS5097: the .ts specifier lets plain node load the table
  table = await import("../../src/agents/descriptor.ts");
} catch {
  // no src/ beside tools/
}

/** Every agent's descriptor row in table order. Throws when src/agents/descriptor.ts is not beside tools/. */
export function agentRows() {
  if (!table) throw new Error("agent table unavailable: src/agents/descriptor.ts is not beside tools/");
  return Object.values(table.AGENTS);
}

/** Every agent id in table order. */
export function agentIds() {
  return agentRows().map((a) => a.id);
}
