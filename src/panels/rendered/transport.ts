// Agent transports: the calls a Rendered body makes TO an agent backend (in-process
// agent.rs or the Falcon host), behind one interface, plus the spawn parameters they take.

import { invoke } from "../../ipc";
import type { Effort, PermissionMode } from "../../agents/protocol";
import { AGENT_PROFILE } from "./agent-profile";
import type { RulesLaunch } from "../../rules/inject";
import type { AgentId } from "../../agents/id";
import { codexThreadHolder, refreshRawCodexThreads } from "../sessions/lookup";

export type RenderedAgent = AgentId;

/** Everything a backend needs to start a process for one tab. */
interface AgentSpawnParams {
  tabId: string;
  /** The tab's name, exported to the process as `VIDAR_TAB_NAME`. */
  tabName?: string | null;
  /** A gateway module id (agent.gateway in the module registry). */
  gateway?: string | null;
  /** Launch profile ("bare"): the backend builds env, home and options from it; no rules file. */
  profile?: string | null;
  /** The launching row's key, sent only with a profile (Rust refuses a rowKey without one). */
  rowKey?: string | null;
  agent: RenderedAgent;
  cwd: string;
  model?: string | null;
  effort?: Effort | null;
  permissionMode: PermissionMode;
  /** Agent session id to resume into, when there is one. */
  resume?: string | null;
  /** Prepared rules for this tab; the backend gets only the built file (Rust re-validates it). */
  rules?: RulesLaunch | null;
  /** Called with the Bare warnings a hosted profiled spawn reports (falcon_spawn `bare_warnings`). */
  onBareWarnings?: (warnings: string[], trust: { folder: string; text: string } | null) => void;
}

/**
 * The three things this body does TO an agent, behind one interface.
 *
 * Everything else here reduces state or draws it; these are the only calls that
 * leave the window. Naming them is what lets a second backend — Falcon, which
 * hosts the child in its own process so a session survives Vidar closing — be
 * substituted without the body knowing, and it keeps the substitution honest:
 * anything a transport cannot do shows up as a missing method rather than as a
 * silently different code path.
 *
 * Events are deliberately NOT here yet. They arrive on one module-level
 * `agent-event`/`agent-exit` listener pair routed by tab id, with generation
 * binding that took two smokes to get right; moving them is a separate step
 * that must not ride along with a pure refactor.
 */
/** What a spawn resolves to. `developerInstructions` is null for every spawn but an in-process Codex
 *  Bare row with a built payload (a hosted spawn: the host sends its own). */
export interface AgentSpawned { gen: number; developerInstructions: string | null }

export interface AgentTransport {
  /** Accepted prompts and their queue are owned by the host. */
  durable?: boolean;
  /** Start a process for this tab; resolves to the backend generation and, for an in-process Codex
   *  Bare row, the rune payload text the adapter sends on thread/start. */
  spawn(params: AgentSpawnParams): Promise<AgentSpawned>;
  /** Write one line to the agent. Rejects on failure. */
  send(tabId: string, gen: number, line: string): Promise<void>;
  /** Stop the process for this generation. */
  kill(tabId: string, gen: number): Promise<void>;
  detach?(tabId: string, gen: number): Promise<void>;
  retract?(tabId: string, gen: number, prompt: string): Promise<void>;
  /** Fold a host-queued prompt into the running turn without interrupting it. */
  steer?(tabId: string, gen: number, prompt: string): Promise<void>;
  /** The launch profile every spawn carries ("bare"): the login card logs in that profile's home. */
  profile?: string;
  /** A gateway tab is its vendor's identity: it gets no Claude login card. */
  gateway?: string;
  /** Never starts a new process (an art the module registry does not know): no login card either,
   *  since a login's respawn would throw and its run would log the default home in. */
  respawnRefused?: boolean;
}

/** A Codex resume of a thread another tab holds is refused before any spawn: two writers on one
 *  rollout (B2). Raw tabs are re-resolved from their own home's rollouts first (codex-thread.ts),
 *  since their launch line names no thread or a stale one. */
async function refuseHeldCodexThread(params: AgentSpawnParams): Promise<void> {
  if (params.agent !== "codex" || !params.resume) return;
  await refreshRawCodexThreads();
  if (codexThreadHolder(params.resume, params.tabId)) throw new Error("This Codex thread is already open in another tab.");
}

/**
 * The in-process backend: Vidar's own `agent.rs`, exactly as it was called
 * before this interface existed. The child dies with Vidar.
 */
/** Hands a profiled spawn's warnings, and a Codex tab's trust offer (the folder the user's own Codex
 *  config does not trust), to `onBareWarnings`. Nothing to report reaches nothing. */
async function reportBare(params: AgentSpawnParams, warnings: string[]): Promise<void> {
  if (!params.onBareWarnings) return;
  let trust: { folder: string; text: string } | null = null;
  if (params.agent === "codex") {
    try { trust = await invoke("codex_trust_offer", { id: params.tabId }); } catch { trust = null; }
  }
  if (warnings.length || trust) params.onBareWarnings(warnings, trust);
}

async function spawnInProcess(params: AgentSpawnParams, profile: string | null, rowKey?: string): Promise<AgentSpawned> {
  if (!AGENT_PROFILE[params.agent].inProcess) {
    throw new Error("claude rendered tabs are hosted by falcon, not spawned in-process");
  }
  await refuseHeldCodexThread(params);
  // A launch profile (bare) sends no rules file and names its row's agent; Rust admits only
  // "codex" and builds the binary, env, home and config.toml itself (bare/, agent.rs).
  if (profile) {
    const reply = await invoke("spawn_codex_appserver", { id: params.tabId, cwd: params.cwd, rulesFile: null, tabName: params.tabName ?? null, profile, ...(rowKey ? { rowKey } : {}), agent: params.agent });
    await reportBare(params, reply.bareWarnings ?? []);
    return { gen: reply.gen, developerInstructions: reply.developerInstructions };
  }
  return await invoke("spawn_codex_appserver", { id: params.tabId, cwd: params.cwd, rulesFile: params.rules?.file ?? null, tabName: params.tabName ?? null });
}

export const tauriAgentTransport: AgentTransport = {
  spawn: (params) => spawnInProcess(params, null),
  async send(tabId, gen, line) {
    await invoke("agent_send", { id: tabId, gen, line });
  },
  async kill(tabId, gen) {
    await invoke("kill_agent", { id: tabId, gen });
  },
};

/**
 * The Falcon backend: the child lives in a separate host process and survives
 * Vidar closing.
 *
 * Only the three actions differ. Falcon's events are re-emitted by the Rust
 * client as the same `agent-event` / `agent-exit` envelope `agent.rs` uses, so
 * the listener, the generation binding and the adapter are shared verbatim
 * rather than reimplemented — the part of this body most expensive to get wrong
 * is the part that does not change.
 *
 * Claude always; Codex only for a tab `AGENT_PROFILE.codex.falconHosted` admitted
 * (rendered-body.ts picks the transport). A Codex spawn names its agent and sends no
 * rules file or gateway; its profile (bare) rides when the host lists codex_bare. A host that cannot run it refuses the spawn (V2,
 * session_commands.rs), which the body shows as a start failure.
 */
export const falconAgentTransport: AgentTransport = {
  durable: true,
  async spawn(params) {
    const codex = params.agent === "codex";
    // The host reports every Codex thread free (session_commands.rs), so a thread another tab holds
    // (Rendered, or a live Raw tab's) is refused here: two writers on one rollout (B2).
    await refuseHeldCodexThread(params);
    const reply = await invoke("falcon_spawn", {
      id: params.tabId,
      cwd: params.cwd,
      model: params.model ?? null,
      effort: params.effort ?? null,
      permissionMode: params.permissionMode,
      resume: params.resume ?? null,
      // a profiled (bare) spawn sends no rules file: its layer comes from the profile (bare/mod.rs admit_hosted)
      rulesFile: params.profile || codex ? null : params.rules?.file ?? null,
      tabName: params.tabName ?? null,
      // omitted for Claude, so a Claude spawn keeps its wire shape
      ...(codex ? { agent: "codex" as const } : {}),
      ...(params.gateway && !codex ? { gateway: params.gateway } : {}),
      ...(params.profile ? { profile: params.profile } : {}),
      ...(params.profile && params.rowKey ? { rowKey: params.rowKey } : {}),
    });
    if (typeof reply === "number") return { gen: reply, developerInstructions: null };
    await reportBare(params, reply.bare_warnings ?? []);
    return { gen: reply.view_generation, developerInstructions: null };
  },
  async send(tabId, gen, line) {
    await invoke("falcon_send", { id: tabId, gen, line });
  },
  async kill(tabId, gen) {
    await invoke("falcon_kill", { id: tabId, gen });
  },
  async detach(tabId, gen) {
    await invoke("falcon_detach", { id: tabId, gen });
  },
  async retract(tabId, gen, prompt) {
    await invoke("falcon_retract", { id: tabId, gen, prompt });
  },
  async steer(tabId, gen, prompt) {
    await invoke("falcon_steer", { id: tabId, gen, prompt });
  },
};

/** The in-process backend for a profiled (bare) Codex tab: every spawn (first start, /clear,
 *  Resume, Retry) carries the tab's profile, so it never respawns as a default tab. */
export function createProfileTransport(profile: string, rowKey?: string): AgentTransport {
  return { ...tauriAgentTransport, profile, spawn: (params) => spawnInProcess(params, profile, rowKey) };
}

export function createGatewayTransport(gateway: string): AgentTransport {
  return { ...falconAgentTransport, gateway, spawn: (params) => falconAgentTransport.spawn({ ...params, gateway }) };
}

/** A Claude tab whose art is neither plain nor a loaded gateway: it never starts a process, since a
 *  respawn would come up as plain Claude outside the gateway's routing and fence. */
export function createRefusedTransport(): AgentTransport {
  return { ...falconAgentTransport, respawnRefused: true, spawn: () => Promise.reject(new Error("Unknown gateway")) };
}

/** The Falcon backend for a profiled (Rendered Bare) Claude tab: every spawn (first start, /clear,
 *  Resume, Retry) carries the profile and the row's key, so it never respawns as a default tab
 *  or without its row. */
export function createFalconProfileTransport(profile: string, rowKey?: string): AgentTransport {
  return { ...falconAgentTransport, profile, spawn: (params) => falconAgentTransport.spawn({ ...params, profile, ...(rowKey ? { rowKey } : {}) }) };
}

/** Adopt exactly once; /clear subsequently starts a new hosted session, under the same gateway,
 *  launch profile and row key the adopter read from the session summary it already holds. `refuseRespawn`
 *  (an art the module registry does not know) adopts but never starts a new process. */
export function createFalconAdoptTransport(session: string, gateway?: string, profile?: string, refuseRespawn = false, rowKey?: string): AgentTransport {
  let adopted = false;
  return {
    ...falconAgentTransport,
    ...(gateway ? { gateway } : {}),
    ...(profile ? { profile } : {}),
    ...(refuseRespawn ? { respawnRefused: true } : {}),
    async spawn(params) {
      if (adopted && refuseRespawn) throw new Error("Unknown gateway");
      if (adopted) return falconAgentTransport.spawn({ ...params, ...(gateway ? { gateway } : {}), ...(profile ? { profile } : {}), ...(profile && rowKey ? { rowKey } : {}) });
      const gen = await invoke("falcon_adopt", { id: params.tabId, session });
      adopted = true;
      return { gen, developerInstructions: null };
    },
  };
}

