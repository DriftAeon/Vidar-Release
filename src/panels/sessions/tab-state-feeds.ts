// Feeds for the tab-state store: each Rendered body's chip, the character status events and the
// Relay asks (resolved to tabs). Publishes only; tab-row-paint.ts draws.

import { items as relayItems, subscribe as subscribeRelay, type RelayItem } from "../../relay/store";
import { deriveRaw, deriveRendered } from "./tab-state";
import type { SessionAgent } from "./types";
import { drop, get, publish } from "./tab-state-store";
import { countAsksByTab } from "./tab-state-format";
import { startTabRowPaint } from "./tab-row-paint";
import { captureFalconTabIdentity, falconTabPairs, resolveFalconTab, type FalconTabMatch } from "./lookup";
import type { chipState } from "../rendered/state-chip";
import type { CharacterStatusDetail } from "../../character/events";

type Chip = ReturnType<typeof chipState>;

const chips = new Map<string, { chip: Chip; pendingTool: string | null; isCurrent: () => boolean }>();
let askCounts = new Map<string, number>();
const sessionTab = new Map<string, FalconTabMatch>(); // Falcon session -> guarded tab
let generation = 0;
let started = false;

/** Accepted PTY spawn/exit events only; the caller checks attachment generation. */
export function feedRaw(id: string, agent: SessionAgent, alive: boolean): void {
  publish(id, deriveRaw(agent, alive), Date.now());
}

function rederive(id: string): void {
  const c = chips.get(id);
  if (c) publish(id, deriveRendered(c.chip, c.pendingTool, askCounts.get(id) ?? 0), Date.now());
}

/** A Rendered body's refreshState(): keep its latest chip and publish the derived state. */
export function feedRendered(id: string, chip: Chip, pendingTool: string | null, hydrating: boolean): void {
  if (hydrating) return;
  const changed = !chips.get(id)?.isCurrent();
  if (changed) forgetRelayTab(id);
  chips.set(id, { chip, pendingTool, isCurrent: captureFalconTabIdentity(id) });
  rederive(id);
  if (changed && started) void onRelay(relayItems());
}

/** The body left the tab (close, jettison): nothing to derive from any more. */
export function feedDetached(id: string): void {
  chips.delete(id);
  forgetRelayTab(id);
  publish(id, { phase: "unknown", reason: null, tool: null }, Date.now());
  if (started) void onRelay(relayItems());
}

/** removeSessionView: the tab is gone. */
export function dropTabState(id: string): void {
  chips.delete(id);
  forgetRelayTab(id);
  drop(id);
  if (started) void onRelay(relayItems());
}

function forgetRelayTab(id: string): void {
  ++generation; // invalidate resolutions started before this removal or identity change
  askCounts.delete(id);
  for (const [session, tab] of sessionTab) if (tab.id === id) sessionTab.delete(session);
}

function pruneRelayTabs(): void {
  for (const [session, tab] of sessionTab) if (!tab.isCurrent()) sessionTab.delete(session);
}

function onStatus(ev: Event): void {
  const d = (ev as CustomEvent<CharacterStatusDetail>).detail;
  if (!d?.id) return;
  const prev = get(d.id);
  publish(d.id, {
    ...(prev ? {} : { phase: "unknown" as const }), // a PTY tab: stateless beyond its first status
    ctxPct: d.contextUsedPercentage ?? prev?.ctxPct ?? null,
    model: d.model ?? prev?.model ?? null,
  }, Date.now());
}

async function onRelay(list: readonly RelayItem[]): Promise<void> {
  const gen = ++generation;
  pruneRelayTabs();
  // a question names its tab (askerTab) or only its Falcon session, which resolves to one below
  const questions = list.flatMap((i) => (i.view.type === "question" ? [i] : []));
  const direct = questions.flatMap((i) => (i.askerTab ? [i.askerTab] : []));
  const sessions = questions.flatMap((i) => (!i.askerTab && i.view.type === "question" && i.view.record.askerSession ? [i.view.record.askerSession] : []));
  const misses = [...new Set(sessions)].filter((s) => !sessionTab.has(s));
  let pairs: Promise<FalconTabMatch[]> | null = null; // one falconTabPairs pass, shared by every miss
  const sharedPairs = () => (pairs ??= falconTabPairs("full"));
  await Promise.all(misses.map(async (s) => {
    const tab = await resolveFalconTab(s, "full", sharedPairs).catch(() => null);
    if (tab?.isCurrent() && gen === generation) sessionTab.set(s, tab);
  }));
  if (gen !== generation) return; // a newer store change owns the result
  pruneRelayTabs();
  const next = countAsksByTab(sessions, (s) => sessionTab.get(s)?.id ?? null);
  for (const id of direct) next.set(id, (next.get(id) ?? 0) + 1);
  const prev = askCounts;
  askCounts = next;
  for (const id of new Set([...prev.keys(), ...next.keys()])) {
    if ((prev.get(id) ?? 0) !== (next.get(id) ?? 0)) rederive(id);
  }
}

/** Start the feeds and the row paint; once, after sessions are initialised. */
export function initTabState(): void {
  started = true;
  startTabRowPaint();
  document.addEventListener("vidar-character-status", onStatus);
  subscribeRelay((list) => { void onRelay(list); });
  void onRelay(relayItems());
}
