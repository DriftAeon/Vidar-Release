// The Rendered body's state record at creation: every field's starting value in one place.
// Split out of rendered.ts; `adapter` is the body's first adapter, built by the caller.

import type { AgentAdapter } from "../../agents/protocol";
import type { RenderedOpts } from "./opts";
import type { RenderedState } from "./state";
import { seededModels } from "./events";

export function initialState(opts: RenderedOpts, adapter: AgentAdapter): RenderedState {
  return {
    hydrating: false,
    disconnected: false,
    pillVersion: undefined,
    pillModel: opts.model ?? undefined,
    pillCwd: opts.cwd,
    pillInstalled: null,
    cacheStamp: 0,
    cacheTtlMs: 3_600_000,
    cacheTimer: undefined,
    characterModel: opts.model ?? null,
    characterModelLive: false,
    lastCharacterStatus: "",
    characterTurnOpen: false,
    characterActive: false,
    mode: opts.permissionMode,
    switchPending: false,
    switchTimer: undefined,
    modelHinted: false,
    loggedOut: false,
    modeBtn: null,
    stMenu: null,
    models: seededModels(opts.agent),
    modelPending: null,
    modelWant: null,
    pickedModel: null,
    modelTimer: undefined,
    modelBtn: null,
    waitingTimer: undefined,
    gen: 0,
    isAlive: false,
    disposed: false,
    sessionId: opts.resume ?? null,
    inTurn: false,
    turnEndWaiters: [],
    interruptSent: false,
    costTotal: 0,
    commands: [],
    adapter,
    pendingApproval: null,
    curGroup: null,
    interimCandidates: [],
    turnGroups: [],
    stick: true,
    replaying: false,
    spawning: null,
    paletteSel: null,
  };
}
