// src\panels\mcp-focus.ts — which MCP config the focused tab reads, derived once for the rack
// (rack.ts), the rail buttons (rail-stripe.ts) and Settings > Modules: a tab whose agent has its
// own config (FOCUS_ROWS.ownConfig) reads it by tab id, any other tab reads the default row's
// (Claude's); an own-config tab's Bare row selects its set home.
import { isGateway } from "../launcher/agent-kind";
import { invoke } from "../ipc";
import type { AgentId } from "../agents/id";
import type { McpRack } from "./rack";
import type { FocusedSession } from "./sessions";
import { tabIdentity } from "./sessions/vault-tabs";

/** The facts one agent contributes to the focus derivation; the code below reads rows only. */
interface FocusRow {
  /** the agent reads its own config by tab id (else the shared default config, scoped by project) */
  ownConfig: boolean;
  /** lists the focused tab's servers (a typed command per row) */
  read: (f: McpFocus) => Promise<McpRack>;
  /** a profiled tab reads the combination home its own session runs on */
  profiledOwnTab: boolean;
  /** the config carries per-project disabled state (gateways excluded) */
  projectScoped: boolean;
  /** the module that must be on for this row to apply */
  module: string;
}

// Keyed by AgentId: a third agent fails tsc here until its row is written.
const FOCUS_ROWS: Record<AgentId, FocusRow> = {
  claude: {
    ownConfig: false, profiledOwnTab: true, projectScoped: true, module: "claude",
    read: ({ project, profile, tab, row }) => invoke("read_mcp_servers", { project, profile, tab, row }),
  },
  codex: {
    ownConfig: true, profiledOwnTab: true, projectScoped: false, module: "codex",
    read: ({ profile, tab, row }) => invoke("read_codex_mcp_servers", { tab, falconSession: tab ? tabIdentity(tab).falconSession : null, profile, row }),
  },
};
/** The row an unknown or gated-off agent reads. */
const DEFAULT_ROW: AgentId = "claude";

export interface McpFocus {
  /** the own-config agent's id (its tab's own config is read); null = the default row's config */
  agent: AgentId | null;
  /** the own-config or profiled default-row tab's id (that tab reads its own session's home); null otherwise */
  tab: string | null;
  /** the project whose disabled state the default config carries: project-scoped tabs only, gateways excluded.
   *  Any other agent reads its own config, so the rack says nothing (null = unknown). */
  project: string | null;
  /** the tab's launch profile (rows with a config only) */
  profile: string | null;
  /** the launching Bare row key, when present */
  row: string | null;
}

/** `moduleOn` lets Settings ignore a row whose module is off; default: every row applies. */
export function mcpFocus(s: FocusedSession | null, moduleOn: (id: string) => boolean = () => true): McpFocus {
  const id = (s?.agent ?? "") as AgentId;
  // an id with no row (a gateway, a shell) reads the default config
  const facts = Object.hasOwn(FOCUS_ROWS, id) ? FOCUS_ROWS[id] : undefined;
  const row = facts && moduleOn(facts.module) ? facts : null;
  // a profiled (Bare) tab of a profiled-own-tab row reads the combination home its own session runs on
  const own = !!row && (row.ownConfig || (row.profiledOwnTab && !!s!.profile));
  return {
    agent: row?.ownConfig ? id : null,
    tab: own ? s!.id : null,
    project: row?.projectScoped && !isGateway(s!.art) && s!.cwd ? s!.cwd : null,
    profile: row && s!.profile ? s!.profile : null,
    row: own ? s!.rowKey ?? null : null,
  };
}

/** Reads this focus's servers through its row's command. */
export function mcpFocusRead(f: McpFocus): Promise<McpRack> {
  return FOCUS_ROWS[f.agent ?? DEFAULT_ROW].read(f);
}

/** One key per distinct read: a focus change with the same key rereads nothing. */
export function mcpFocusKey(f: McpFocus): string {
  const id = f.agent ?? DEFAULT_ROW;
  return FOCUS_ROWS[id].ownConfig ? JSON.stringify([id, f.tab, f.profile, f.row]) : JSON.stringify([id, f.project, f.profile, f.tab, f.row]);
}
