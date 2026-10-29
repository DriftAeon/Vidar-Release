// What differs per agent in a Rendered body: adapter, permission modes, wording, transport
// route and the capabilities the status bar and slash commands gate on. `AGENT_PROFILE` is an
// exhaustive Record, so a new `RenderedAgent` fails to compile until every field is stated.

import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { HostedCodexAdapter } from "./codex-hosted";
import { getPref, setPref } from "../prefs";
import { initCodexPlans } from "./codex-plan-store";
import { CODEX_EFFORT_LEVELS, codexEffort, codexModelsPref } from "./codex-settings";
import type { AgentAdapter, AgentEvent, Effort, PermissionMode } from "./protocol";
import { EFFORT_LEVELS, PERMISSION_MODES } from "./protocol";
import { CODEX_LOGIN_TIP, claudeLoginTip } from "./login-tips";
import type { AgentId } from "./id";
import type { LoginReach } from "../panels/rendered/login";

/** The agents a Rendered body can run (an alias of the one agent id). */
export type RenderedAgent = AgentId;

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
  /** the mode pill's wording per permission mode */
  modeLabels: Readonly<Record<PermissionMode, string>>;
  /** a sent setter line (mode, model, effort) is applied once send() reports true: the host's
   *  Applied. Otherwise the agent's own ack event settles it. */
  settlesOnSend: boolean;
  /** an encoder that returns null stages the model/effort locally for the next turn, rather than
   *  meaning the agent cannot take it */
  stagedLocally: boolean;
  /** the model menu groups its rows (model-groups.ts) */
  groupModels: boolean;
  /** the effort levels come from the running model's catalog row, the profile's list as fallback */
  perModelEffort: boolean;
  /** a running turn blocks an effort pick (the effort applies per turn) */
  busyBlocksEffort: boolean;
  /** a running turn blocks a mode change; Claude takes one mid-turn (applies from the next tool call) */
  busyBlocksMode: boolean;
  /** the level actually sent for a pick, given what the model offers; undefined = nothing to send */
  clampEffort: (level: Effort, levels: readonly Effort[]) => Effort | undefined;
  /** the status bar carries the command cabinet button */
  commandCabinet: boolean;
  /** awaited at the head of every spawn (lifecycle.ts); null = nothing to prepare */
  beforeSpawn: (() => Promise<void>) | null;
  /** a resume of a thread another tab holds is refused before any spawn (transport.ts refuseHeldCodexThread; the
   *  check needs panels/sessions/lookup, so the profile carries the flag, not the function) */
  refusesHeldResume: boolean;
  /** a Bare spawn asks the host for the trust offer on the tab's folder (transport.ts reportBare) */
  trustOffer: boolean;
  /** a non-profiled Falcon spawn sends the tab's rules file (a profiled one never does) */
  sendsRulesFile: boolean;
  /** the Falcon spawn names its agent on the wire; omitted for Claude so its wire shape stays */
  namesAgentOnWire: boolean;
  /** a Falcon spawn forwards the tab's gateway module */
  sendsGateway: boolean;
  /** saves a models event into the agent's own model-list pref; saves nothing for an empty list or (Codex) a partial page */
  saveModels: (models: Extract<AgentEvent, { kind: "models" }>["models"], partial: boolean) => void;
}

/** The mode wording shared by every agent, and the one used when no agent is named. */
export const MODE_LABELS: Readonly<Record<PermissionMode, string>> = { default: "Default", acceptEdits: "Accept Edits", plan: "Plan", auto: "Auto" };

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
    modeLabels: MODE_LABELS,
    settlesOnSend: false,
    stagedLocally: false,
    groupModels: true,
    perModelEffort: false,
    busyBlocksEffort: false,
    busyBlocksMode: false,
    clampEffort: (level) => level,
    commandCabinet: true,
    beforeSpawn: null,
    refusesHeldResume: false,
    trustOffer: false,
    sendsRulesFile: true,
    namesAgentOnWire: false,
    sendsGateway: true,
    saveModels: (models) => {
      if (!models.length) return;
      const next = models.map((m) => ({ value: m.value, label: m.label, resolved: m.resolved }));
      if (JSON.stringify(getPref("claudeModels")) !== JSON.stringify(next)) setPref("claudeModels", next);
    },
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
    modeLabels: { ...MODE_LABELS, auto: "Auto Review" },
    settlesOnSend: true,
    stagedLocally: true,
    groupModels: false,
    perModelEffort: true,
    busyBlocksEffort: true,
    busyBlocksMode: true,
    clampEffort: codexEffort,
    commandCabinet: false,
    beforeSpawn: initCodexPlans,
    refusesHeldResume: true,
    trustOffer: true,
    sendsRulesFile: false,
    namesAgentOnWire: true,
    sendsGateway: false,
    // Settings › Agents reads it; the tab's own picker stays session-only
    saveModels: (models, partial) => {
      if (!models.length || partial) return;
      const next = codexModelsPref(models);
      if (JSON.stringify(getPref("codexModels")) !== JSON.stringify(next)) setPref("codexModels", next);
    },
  },
};
