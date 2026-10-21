// Mutable state of one Rendered body: the closure `let`s of createRenderedBody, owned by one
// object (flow/state.ts precedent) so rendered/* modules take it instead of closing over it.
// One instance per body, built at the top of createRenderedBody; fields keep the old names.

import type { AgentAdapter, Effort, PermissionMode } from "../../agents/protocol";

/** Activity group: one <details> collecting consecutive top-level
 *  tool pills and thinking rows. `sealed` = no longer collecting (a text/user/
 *  footer block landed). A live sealed group folds once nothing in it is running (at seal
 *  time, or when its last pill settles); `keepOpen` (a `!` command) waits for turn_done,
 *  which collapses whatever is left. A pill keeps its group for life — a late result
 *  updates that group's summary. */
export type Group = { details: HTMLDetailsElement; label: HTMLElement; counts: Map<string, number>; sealed: boolean; error: boolean; userToggled: boolean; thinking: Set<string>; keepOpen?: boolean; folded?: boolean };

/** One tool pill in the transcript, keyed by toolUseId in the body's `tools` map. subagentType and
 *  subagentDesc: an Agent call's subagent_type and description, or a SendMessage call's `to` and summary. */
export type ToolRecord = { details: HTMLDetailsElement; out: HTMLPreElement | null; children: HTMLElement | null; name: string; group: Group | null; card: HTMLElement | null; subagentType?: string; subagentDesc?: string };

/** One background-agent row in the agents block, keyed by task id in the body's `waiting` map. */
export type WaitingRow = {
  label: string; title: string; since: number; toolUseId?: string;
  done: boolean; failed: boolean; needs: boolean; elapsedFrozen?: string; summaryShown?: boolean;
  row: HTMLElement; marker: HTMLElement; word: HTMLElement; bar: HTMLElement;
  calls: HTMLElement; time: HTMLElement;
  /** the row's end while it is open: the finished agent's token total and the Show In Chat button */
  tokensCell: HTMLElement; showBtn: HTMLElement;
  /** the row's description cell; shows the verdict once a report exists */
  desc?: HTMLElement;
  /** the agent's final report (hand-back or notification result) and its token total, when they arrived */
  report?: string; tokens?: number;
  /** a resumed agent's report from its previous run, shown in the drawer until the new one lands */
  prevReport?: string;
  /** parked: the agent ended its turn while background tasks a subagent started still run. The CLI
   *  drops it from the live set and sends a "completed" notification that a wake supersedes, so the
   *  row keeps running; held is that notification (and when it came), applied only if the agent
   *  never runs again. drained: those tasks ended, so the next live set re-lists it or settles it. */
  parked?: { held?: { status?: string; summary?: string; report?: string; tokens?: number; at: number }; drained: boolean };
};

/** The status line's values (`sl` in createRenderedBody). */
export type StatusLine = {
  dir: string;
  model: string;
  mode: string;
  ctxPct: number | null;
  ctxTokens: number;
  contextWindow: number | null;
  limits: Map<string, { pct: number; resetsAt: number | null }>;
  /** reasoning effort for the current turn ("high"); arrives via the sidecar's Stop hook */
  effort: string;
};

export interface RenderedState {
  hydrating: boolean;
  disconnected: boolean;
  pillVersion: string | undefined;
  pillModel: string | undefined;
  pillCwd: string;
  /** installed Claude Code, fetched only for a hosted tab (its bundle can lag) */
  pillInstalled: string | null;
  cacheStamp: number;
  cacheTtlMs: number;
  cacheTimer: number | undefined;
  characterModel: string | null;
  characterModelLive: boolean;
  /** the effort level the sidecar last reported; a Retry/Resume respawns on it */
  liveEffort?: Effort;
  lastCharacterStatus: string;
  characterTurnOpen: boolean;
  characterActive: boolean;
  mode: PermissionMode;
  switchPending: boolean;
  switchTimer: number | undefined;
  /** the shown model is the settings' expectation, not yet the CLI's word */
  modelHinted: boolean;
  /** Claude Code said it has no credentials (rendered/login.ts); the pill and chip say so */
  loggedOut: boolean;
  modeBtn: HTMLButtonElement | null;
  stMenu: HTMLElement | null;
  models: { value: string; label: string; resolved?: string; effortLevels?: readonly Effort[] }[];
  modelPending: string | null;
  /** menu value sent by the in-flight setModel pick */
  modelWant: string | null;
  /** menu value of the last pick the CLI confirmed; marks the menu row first. Cleared by init. */
  pickedModel: string | null;
  modelTimer: number | undefined;
  modelBtn: HTMLButtonElement | null;
  waitingTimer: number | undefined;
  gen: number;
  isAlive: boolean;
  disposed: boolean;
  sessionId: string | null;
  inTurn: boolean;
  // Resolvers for `waitForTurnEnd`, settled by `setInTurn(false)`; lets `stopAgent`
  // give an interrupted turn a chance to wind down before it kills the process.
  turnEndWaiters: Array<() => void>;
  // "error_during_execution" is also what a real mid-turn failure reports, so the footer
  // may only read "Interrupted" when we know we asked for it
  interruptSent: boolean;
  costTotal: number;
  commands: string[];
  adapter: AgentAdapter;
  pendingApproval: string | null; // requestId of the card Esc denies
  curGroup: Group | null;
  /** Interleaved turns: a text block followed by a top-level tool call in the
   *  same turn is interim, not the reply. It is dimmed (`.interim`) from the
   *  moment the tool pill lands until turn_done; the tool row between the two texts carries the
   *  distinction after that. Not applied on replay: history has no live turn to be interim in. */
  interimCandidates: HTMLElement[];
  turnGroups: Group[];
  stick: boolean;
  replaying: boolean; // history replay: no per-block scroll or activity, one scroll at the end
  /** The spawn currently in flight. `stopAgent` awaits it before reading `gen`: a /clear or
   *  shutdown landing while `transport.spawn` is still resolving would otherwise kill a
   *  dead generation and drop the route of the agent that is starting, leaving an orphan
   *  holding the tab id and every retry answered with "agent already exists or is closing". */
  spawning: Promise<void> | null;
  paletteSel: string | null;
}
