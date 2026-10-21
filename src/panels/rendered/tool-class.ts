// A coarse class per tool name, per agent, so UI code asks "is this an edit?" instead of
// comparing wire names. Import-free of values. Unknown names (and every MCP tool) are "other".

import type { RenderedAgent } from "./transport";

export type ToolClass = "read" | "search" | "edit" | "run" | "web" | "ask" | "agent" | "think" | "other";

/** Names each adapter emits (src/agents/claude.ts passes the SDK's names through; codex.ts maps
 *  item types to "Command" / "Edit" / "WebSearch"). "Thought" is the activity group's own key. */
export const TOOL_CLASS: Record<RenderedAgent, Readonly<Record<string, ToolClass>>> = {
  claude: {
    Read: "read",
    Grep: "search", Glob: "search",
    Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit",
    Bash: "run", PowerShell: "run",
    WebFetch: "web", WebSearch: "web",
    AskUserQuestion: "ask",
    Agent: "agent", Task: "agent",
    Thought: "think",
    ToolSearch: "think", // same green underline as Thought (2026-10-05)
  },
  codex: {
    Command: "run",
    Edit: "edit",
    WebSearch: "web",
    Thought: "think",
    AskUserQuestion: "ask",
    Agent: "agent", SendMessage: "agent", Wait: "agent", CloseAgent: "agent", InterruptAgent: "agent", ListAgents: "agent",
  },
};

export function toolClass(name: string, agent: RenderedAgent): ToolClass {
  return Object.hasOwn(TOOL_CLASS[agent], name) ? TOOL_CLASS[agent][name] : "other";
}
