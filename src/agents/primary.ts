// src\agents\primary.ts — the primary agent: vidar.json `primaryAgent` ("codex" | "claude", optional)
// resolved against the agent modules that are active right now. Installed means active in the
// module registry (`modulesOf("agent")`, the same list `pickSetupRunner` reads). Its runtime
// imports (id.ts, descriptor.ts) carry a `.ts` suffix, so `node --test` loads it directly:
// settings/agents.ts binds the two sources at boot (`setPrimarySources`), and every consumer reads
// `effectivePrimary()` at use time.

// @ts-ignore TS5097: the .ts specifiers let node --test load this file without a bundler
import { isAgentId } from "./id.ts";
// @ts-ignore TS5097
import { agentOrder } from "./descriptor.ts";
import type { AgentId } from "./id.ts";

export type PrimaryAgent = AgentId;

/** The slice of a module row the resolver reads (structural, so registry rows fit). */
export interface PrimaryModule {
  id: string;
  kind?: string;
  agent?: { setup?: { order?: number } };
}

const isPick = isAgentId;

/** Pure: the active primary-capable agents by ascending `agent.setup.order` (absent sorts last,
 *  ties keep registry order), so unset with both active gives today's order: Claude (0), Codex (1). */
export function choicesOf(active: readonly PrimaryModule[]): PrimaryAgent[] {
  const rank = (m: PrimaryModule): number => m.agent?.setup?.order ?? Number.POSITIVE_INFINITY;
  const seen = new Set<PrimaryAgent>();
  return active
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => (m.kind === undefined || m.kind === "agent") && isPick(m.id))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => m.id as PrimaryAgent)
    .filter((id) => !seen.has(id) && !!seen.add(id));
}

/** Pure: the saved pick when it is active, else the other agent when active, else null. Unset (or
 *  not a valid pick) falls to the first of `choicesOf`. */
export function resolvePrimary(saved: unknown, active: readonly PrimaryModule[]): PrimaryAgent | null {
  const choices = choicesOf(active);
  if (isPick(saved)) {
    if (choices.includes(saved)) return saved;
    return agentOrder(saved).find((a) => choices.includes(a)) ?? null;
  }
  return choices[0] ?? null;
}

let savedSource: () => unknown = () => undefined;
let activeSource: () => readonly PrimaryModule[] = () => [];

/** Binds the saved pick (vidar.json `primaryAgent`) and the active agent modules. */
export function setPrimarySources(saved: () => unknown, active: () => readonly PrimaryModule[]): void {
  savedSource = saved;
  activeSource = active;
}

/** The primary agent right now; null when neither Codex nor Claude is active. */
export function effectivePrimary(): PrimaryAgent | null {
  return resolvePrimary(savedSource(), activeSource());
}

/** True once `primaryAgent` is in vidar.json (the first-run card asks only while false). */
export function primaryAsked(): boolean {
  return isPick(savedSource());
}

/** The agents the user can pick from: the active ones, in setup order. */
export function primaryChoices(): PrimaryAgent[] {
  return choicesOf(activeSource());
}
