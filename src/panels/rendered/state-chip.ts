// The one status a Rendered body's composer shows: the state chip's `data-state` (colour) and its
// tooltip (the status word, then session id and running cost). Pure: the body passes its signals.
// Moved out of rendered.ts with the "Not Logged In" state (first-run smoke 2026-10-08). Type
// imports only, so tests load it under Node type stripping.

import type { RenderedState } from "./state";

/** The chip and the model pill while logged out (rendered/login.ts); the Dependencies row says the same. */
export const NOT_LOGGED_IN = "Not Logged In";

/** `spawning`: a spawn in flight (a respawn after a Rune Vault edit included) reads Starting… even after the
 *  sidecar's ready line, which binds before `transport.spawn` resolves: `write()` refuses until it clears, so
 *  Ready must not show meanwhile (E1 run 3, case 2). `holding`: a respawn's send hold, which starts before its spawn
 *  (the old process is still being stopped) and reads Starting… too (E1 run 4, case 2). */
export type ChipSignals = Pick<RenderedState, "hydrating" | "disconnected" | "isAlive" | "pendingApproval" | "inTurn" | "loggedOut" | "sessionId" | "costTotal"> & { spawning?: unknown; holding?: boolean };

/** Whether a bus `write()` with a trailing `\r` submits now (rendered.ts): false while starting, respawning,
 *  restoring, disconnected or closed. The chip's Ready means exactly this, so the two read the same signals. */
export function promptReady(S: Pick<RenderedState, "isAlive" | "hydrating" | "disconnected" | "disposed"> & { spawning?: unknown; holding?: boolean }): boolean {
  return S.isAlive && !S.spawning && !S.holding && !S.hydrating && !S.disconnected && !S.disposed;
}

export type ChipKey = "restoring" | "disconnected" | "stopped" | "approval" | "working" | "agents" | "starting" | "login" | "ready";

/** Priority: restoring > disconnected > stopped > approval > working > agents > starting >
 *  not logged in > ready. `starting` = the status line still on "Starting…", or a spawn in flight. `key` names the
 *  state for readers that must not parse the tooltip (the left-bar tab state, tab-state.ts). */
export function chipState(S: ChipSignals, starting: boolean, agentsRunning: number): { key: ChipKey; cls: string; title: string } {
  const [key, text, cls]: [ChipKey, string, string] = S.hydrating ? ["restoring", "Restoring", "working"]
    : S.disconnected ? ["disconnected", "Disconnected", "dead"]
    : !S.isAlive ? ["stopped", "Stopped", "dead"]
    : S.pendingApproval ? ["approval", "Waiting for approval", "approval"]
    : S.inTurn ? ["working", "Working", "working"]
    : agentsRunning ? ["agents", "Waiting on agents", "working"]
    : starting || S.spawning || S.holding ?["starting", "Starting…", "idle"]
    : S.loggedOut ? ["login", NOT_LOGGED_IN, "login"]
    : ["ready", "Ready", "idle"];
  // Session id and running cost live in this tooltip, not the model title: the chip is always
  // present at a fixed width; unlike the cache slot, it is never empty.
  const details = [
    S.sessionId ? `Session ${S.sessionId}` : "",
    S.costTotal ? `Cost $${S.costTotal.toFixed(2)}` : "",
  ].filter(Boolean);
  return { key, cls, title: [text, ...details].join("\n") };
}
