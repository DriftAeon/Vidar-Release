// What differs per agent in a Rendered body: adapter, permission modes, wording, transport
// route and the capabilities the status bar and slash commands gate on. `AGENT_PROFILE` is an
// exhaustive Record, so a new `RenderedAgent` fails to compile until every field is stated.

import { ClaudeAdapter } from "../../agents/claude";
import { CodexAdapter } from "../../agents/codex";
import { HostedCodexAdapter } from "../../agents/codex-hosted";
import { CODEX_EFFORT_LEVELS } from "../../agents/codex-settings";
import type { AgentAdapter, Effort, PermissionMode } from "../../agents/protocol";
import { EFFORT_LEVELS, PERMISSION_MODES } from "../../agents/protocol";
import { CODEX_LOGIN_TIP } from "./api-key-card";
import { claudeLoginTip } from "./claude-login";
import type { LoginReach } from "./login";
import type { RenderedAgent } from "./transport";

/** The host capability a Codex session needs (src-falcon protocol.rs `CAPABILITY_CODEX_TURNS`). */
export const CODEX_TURNS = "codex_turns";

/** The host capability a profiled (Bare) Codex session needs on top of `codex_turns`
 *  (src-falcon protocol.rs `CAPABILITY_CODEX_BARE`). */
export const CODEX_BARE = "codex_bare";

/** What decides whether a tab's agent runs in the Falcon host. */
export interface FalconHostCheck {
  /** vidar.json `falcon.hostedCodex`: hosted Codex is opt-in until the live journeys pass */
  hostedCodex: boolean;
  /** the host's negotiate capabilities (`falcon_list`); null = not asked, or Falcon unavailable */
  capabilities: readonly string[] | null;
  rulesFile: string | null;
  /** launch profile (bare) */
  profile: string | null;
}

/** A Codex tab of this shape may be hosted once the host says it can: the gate is on, it has no
 *  rules file (stays in-process, spec Q5), and its profile, if any, is `bare` (the only one the
 *  host admits). Checked before the capability probe, since `falcon_list` launches a host. */
export function codexHostShape(c: Omit<FalconHostCheck, "capabilities">): boolean {
  return c.hostedCodex && !c.rulesFile && (!c.profile || c.profile === "bare");
}

export interface AgentProfile {
  /** start-pill name */
  label: string;
  /** one adapter per process generation; `hosted` = the transport is Falcon's (durable) */
  newAdapter: (hosted?: boolean) => AgentAdapter;
  /** the mode switch's agent-specific cycle */
  permissionModes: readonly PermissionMode[];
  /** the replay card's "N <Noun>" */
  resumeNoun: string;
  /** `tauriAgentTransport` can spawn it in-process (agent.rs) */
  inProcess: boolean;
  /** `falconAgentTransport` spawns it for a tab of this shape on this host */
  falconHosted: (c: FalconHostCheck) => boolean;
  /** levels the status bar's effort picker offers; empty = the effort is a label only */
  effortLevels: readonly Effort[];
  /** the model is a picker backed by an agent setter or next-turn override */
  modelMenu: boolean;
  /** `/model`, `/effort`, `/resume` are answered locally by the body */
  localCommands: boolean;
  /** `/resume` opens the launcher's past-session picker for the body's cwd */
  resumeCommand: boolean;
  /** the adapter can raise AskUserQuestion. Not branched on today. */
  askUserQuestion: boolean;
  /** the adapter can raise Agent/Task tool calls. Not branched on today. */
  subagents: boolean;
  /** the logged-out notice and status-bar tip, by how the tab gets back in */
  loginTip: (reach: LoginReach) => string;
  /** a spawn runs the host's login check (`claude auth status`) and the CLI's reply sets the logged-out state */
  loginCheck: boolean;
}

export const AGENT_PROFILE: Record<RenderedAgent, AgentProfile> = {
  claude: {
    label: "Claude Code",
    newAdapter: () => new ClaudeAdapter(),
    permissionModes: PERMISSION_MODES,
    resumeNoun: "messages",
    inProcess: false,
    falconHosted: () => true,
    effortLevels: EFFORT_LEVELS,
    modelMenu: true,
    localCommands: true,
    resumeCommand: true,
    askUserQuestion: true,
    subagents: true,
    loginTip: claudeLoginTip,
    loginCheck: true,
  },
  codex: {
    label: "Codex",
    newAdapter: (hosted) => hosted ? new HostedCodexAdapter() : new CodexAdapter(),
    permissionModes: ["default", "plan", "auto"],
    resumeNoun: "turns",
    inProcess: true,
    falconHosted: (c) => codexHostShape(c) && !!c.capabilities?.includes(CODEX_TURNS)
      && (!c.profile || !!c.capabilities?.includes(CODEX_BARE)), // an old host stays in-process for Bare
    effortLevels: CODEX_EFFORT_LEVELS,
    modelMenu: true,
    localCommands: true,
    resumeCommand: true,
    askUserQuestion: true,
    subagents: true,
    loginTip: () => CODEX_LOGIN_TIP,
    loginCheck: false,
  },
};
