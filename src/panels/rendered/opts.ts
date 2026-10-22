// Construction options of a Rendered body (and the session info it reports back),
// shared by rendered.ts and the rendered/* modules that read `opts`.

import type { Effort, PermissionMode } from "../../agents/protocol";
import type { RulesLaunch } from "../../rules/inject";
import type { RenderedHostId } from "./host-profile";
import type { AgentTransport, RenderedAgent } from "./transport";
import type { chipState } from "./state-chip";

interface RenderedSessionInfo {
  sessionId: string;
  model: string;
  cwd: string;
  permissionMode: string;
}

/** Every key is required: a host states each one, `null` meaning "none". `RENDERED_OPTS_COMPLETE`
 *  fails the build if an optional key creeps back in. */
export interface RenderedOpts {
  tabId: string;
  /** The tab's name at spawn (`VIDAR_TAB_NAME`); `null` for a host with no named tab. */
  tabName: string | null;
  /** Typed source of host identity (`host-profile.ts`); never derived from `tabId`. */
  host: RenderedHostId;
  agent: RenderedAgent;
  cwd: string;
  /** Which backend runs the agent; `null` is Vidar's own in-process one. */
  transport: AgentTransport | null;
  model: string | null;
  effort: Effort | null;
  permissionMode: PermissionMode;
  /** Rules prepared for this tab (rules/inject.ts), passed to every spawn and respawn; its
   *  warnings are shown once, at the first spawn. `null` = none. */
  rules: RulesLaunch | null;
  /** Claude session id to resume into this body */
  resume: string | null;
  /** Composer text to preload, for a Jettison/Dock handoff (never through
   *  `write()`: that refuses before the body is alive, see `write()` in rendered.ts). */
  draft: string | null;
  /** Fires once the FIRST spawn attempt settles — `true` once `transport.spawn()`
   *  has actually resolved (for the Falcon adopt transport, once the host has
   *  granted the lease), `false` if it threw. `createRenderedBody` itself
   *  returns before this: its caller does not wait on the process, only on
   *  the view existing (a Dock must not report success
   *  before Vidar holds the lease). */
  onAdopted: ((ok: boolean, reason?: string) => void) | null;
  /** `/resume`: the host opens its past-session list (Vidar's launcher, Falcon's picker). */
  onResume: () => void;
  /** The failed-spawn pane's Select Workspace… button (a Codex home-folder refusal): the host picks a
   *  folder and opens a replacement tab. Resolves on a pick or a cancel, rejects with the failed spawn's
   *  message. Null/absent (Falcon's window): no button. */
  onSelectWorkspace: (() => Promise<void>) | null;
  /** The trust card's Refresh: open a fresh tab in this folder; `keepThis` leaves this tab open (it has
   *  a chat). Absent (Falcon's window, harnesses): the card shows no Refresh. */
  onReopenHere: ((keepThis: boolean) => Promise<void>) | null;
  /** Set for a Bare (profiled) tab: `/resume` shows this notice instead of calling `onResume`
   *  (the launcher's thread list reads the default home, not this tab's). */
  resumeNotice: string | null;
  onSession: ((info: RenderedSessionInfo) => void) | null;
  /** The permission mode changed (the status bar's switch settled). */
  onModeChange: (() => void) | null;
  onDead: () => void;
  /** Every successful spawn or respawn (first start, /clear, Resume, Restart, Retry). */
  onAlive: (() => void) | null;
  /** background output arrived (sessions.ts marks the tab) */
  onActivity: (() => void) | null;
  onCharacterStatus: ((status: { model: string | null; contextUsedPercentage: number | null; fresh: boolean }) => void) | null;
  onCharacterActivity: ((active: boolean) => void) | null;
  onCharacterCompletion: (() => void) | null;
  /** A turn finished outside history replay (auto-speak): fires
   *  for every completed reply, success or not, so the caller decides what's
   *  worth reading aloud. Never fires for resume replay. */
  onReplyDone: (() => void) | null;
  /** Raw tool events: the same `toolUseId`/`name`/
   *  `input` and `toolUseId`/`isError` the transcript itself renders from
   *  (`rendered/events.ts`'s tool_start/tool_done handling) — a caller watches for one particular call (e.g. a Read
   *  of a known path) landing clean. Fires during replay too; a caller that
   *  cares only about live activity must gate on its own state. */
  onToolStart: ((toolUseId: string, name: string, input: unknown, parentToolUseId: string | null) => void) | null;
  onToolDone: ((toolUseId: string, isError: boolean) => void) | null;
  /** Every `refreshState()`: the status chip, the pending approval card's tool (or null) and
   *  whether history is still replaying (the left-bar tab row, sessions/tab-state-feeds.ts). */
  onTabState: ((chip: ReturnType<typeof chipState>, pendingTool: string | null, hydrating: boolean) => void) | null;
}

type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];
/** Tripwire: resolves to `never` (a type error) while any `RenderedOpts` key is optional.
 *  @public compile-time assert; nothing imports it */
export const RENDERED_OPTS_COMPLETE: [OptionalKeys<RenderedOpts>] extends [never] ? true : never = true;
