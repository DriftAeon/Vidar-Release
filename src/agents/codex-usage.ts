// Codex usage notifications → protocol shapes: thread/tokenUsage/updated and account/rateLimits/updated.
// Pure; the adapter keeps the assignments.

import type { AgentEvent, Usage } from "./protocol";

type Json = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** the last request's usage and the model's context window (null when the notification omits it) */
export function codexTokenUsage(p: Json): { usage: Usage; contextWindow: number | null } {
  const tu = obj(p.tokenUsage) ?? {};
  const last = obj(tu.last) ?? {};
  // inputTokens is the prompt side of the last request (INFERRED to include
  // the cached part; cacheRead/cacheCreate stay 0 so the body does not
  // double count) — checked against the TUI's gauge at implementation
  return {
    usage: {
      inputTokens: num(last.inputTokens) ?? 0,
      outputTokens: num(last.outputTokens) ?? 0,
      cacheRead: 0,
      cacheCreate: 0,
    },
    contextWindow: num(tu.modelContextWindow),
  };
}

/** one rate_limit event per window the notification carries */
export function codexRateLimits(p: Json): AgentEvent[] {
  const rl = obj(p.rateLimits) ?? {};
  const out: AgentEvent[] = [];
  for (const k of ["primary", "secondary"]) {
    const w = obj(rl[k]);
    if (!w) continue;
    const mins = num(w.windowDurationMins);
    const window = mins === 300 ? "five_hour" : mins === 10080 ? "seven_day" : `other-${mins ?? k}`;
    out.push({ kind: "rate_limit", window, utilization: num(w.usedPercent), resetsAt: num(w.resetsAt), status: "allowed" });
  }
  return out;
}
