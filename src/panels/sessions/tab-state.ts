// The one state a left-bar tab row draws: phase, why it needs you, and the live facts beside it.
// Pure and DOM-free; the store (tab-state-store.ts) owns `since`, ctx and model. Type imports only,
// so tests load it under Node type stripping.

import type { chipState } from "../rendered/state-chip";
import type { SessionAgent } from "./types";

/** `dead`: the process ended (Stopped); `lost`: the host link dropped (Disconnected), the one that is an issue. */
type TabPhase = "working" | "needs" | "ready" | "idle" | "dead" | "lost" | "unknown";

export type TabReason = { kind: "question" } | { kind: "permission"; tool: string } | { kind: "relay"; count: number };

export interface TabState {
  phase: TabPhase;
  reason: TabReason | null;
  since: number;
  ctxPct: number | null;
  model: string | null;
  tool: string | null;
}

/** What a body derives itself; the store adds `since`, ctx and model. */
export type DerivedTab = Pick<TabState, "phase" | "reason" | "tool">;

/** Raw tabs expose PTY attachment state, not turn/approval boundaries or CLI exit codes.
 *  `ready` means the terminal is attached; `dead` means that attachment ended. */
export function deriveRaw(agent: SessionAgent, alive: boolean): DerivedTab {
  return { phase: agent === "shell" ? "unknown" : alive ? "ready" : "dead", reason: null, tool: null };
}

/** Map the chip's `key` (same priority as `chipState`) to a phase. A question reason wins over a
 *  relay ask; a relay ask never revives a dead tab. */
export function deriveRendered(chip: ReturnType<typeof chipState>, pendingTool: string | null, askCount: number): DerivedTab {
  let phase: TabPhase;
  let reason: TabReason | null = null;
  const k = chip.key;
  if (k === "restoring" || k === "login") phase = "unknown";
  else if (k === "disconnected") phase = "lost";
  else if (k === "stopped") phase = "dead";
  else if (k === "approval") {
    phase = "needs";
    reason = pendingTool === "AskUserQuestion" ? { kind: "question" } : { kind: "permission", tool: pendingTool ?? "" };
  } else if (k === "working" || k === "agents" || k === "starting") phase = "working";
  else phase = "ready";
  if (askCount > 0 && phase !== "dead" && phase !== "lost" && phase !== "needs") {
    phase = "needs";
    reason = { kind: "relay", count: askCount };
  }
  return { phase, reason, tool: pendingTool };
}

/** Verbatim reason copy (round-3 generator). */
export function reasonText(r: TabReason): string {
  return r.kind === "question" ? "Question"
    : r.kind === "permission" ? `Permission · ${r.tool}`
    : `Relay Ask · ${r.count}`;
}
