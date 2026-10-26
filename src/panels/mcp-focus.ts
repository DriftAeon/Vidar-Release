// src\panels\mcp-focus.ts — which MCP config the focused tab reads, derived once for the rack
// (rack.ts) and the rail buttons (rail-stripe.ts): a Codex tab reads its own config by tab id,
// any other tab Claude's; a Codex tab's Bare row selects its set home.
import { isGateway } from "../launcher/agent-kind";
import type { FocusedSession } from "./sessions";

export interface McpFocus {
  /** "codex" = the tab's own config (read_codex_mcp_servers); null = Claude's (read_mcp_servers) */
  agent: "codex" | null;
  /** the Codex or profiled Claude tab's id (that Claude tab reads its own session's home); null otherwise */
  tab: string | null;
  /** the project whose disabled state Claude's config carries: Claude tabs only, gateways excluded.
   *  Any other agent reads its own config, so the rack says nothing (null = unknown). */
  project: string | null;
  /** the Claude or Codex tab's launch profile */
  profile: string | null;
  /** the launching Bare row key, when present */
  row: string | null;
}

export function mcpFocus(s: FocusedSession | null): McpFocus {
  const claude = s?.agent === "claude", codex = s?.agent === "codex";
  // a profiled (Bare) Claude tab reads the combination home its own session runs on
  const own = codex || (claude && !!s!.profile);
  return {
    agent: codex ? "codex" : null,
    tab: own ? s!.id : null,
    project: claude && !isGateway(s!.art) && s!.cwd ? s!.cwd : null,
    profile: (claude || codex) && s!.profile ? s!.profile : null,
    row: own ? s!.rowKey ?? null : null,
  };
}

/** One key per distinct read: a focus change with the same key rereads nothing. */
export function mcpFocusKey(f: McpFocus): string {
  return f.agent === "codex" ? JSON.stringify(["codex", f.tab, f.profile, f.row]) : JSON.stringify(["claude", f.project, f.profile, f.tab, f.row]);
}
