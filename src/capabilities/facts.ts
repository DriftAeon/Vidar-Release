/* Capability facts: the only module that acquires what the capability
   registry resolves against. registry.ts keeps the DOM lifecycle and asks here for a snapshot in
   every diff.

   Sources:
   - the dependency report (deps/state.ts): no report fails OPEN, every dependency reads found;
   - the vidar.json `capabilities` overlay, off-only;
   - named facts, listed in FACT_IDS below, which fail CLOSED (absent until
     proven; a failed or late probe means hidden):
       `characters`: at least one pack is listed, whatever its status: the
         panel's own placeholder names a missing, changed or invalid pack and points at Settings,
         so a bad pack must not hide it. A failed list still reads as absent.

   settle() hands back one bounded wait per source, so each capability waits only on what it
   declares: speak on detection, character on the list.

   onFactsChange fires on a dependency report (after its re-probe), on every config re-read, and
   when a cached named fact actually changes. A diff never probes, so a diff cannot trigger
   another. The registry keeps a capability out of every diff until its own settle() waits (and
   those of what it dependsOn) have resolved, so nothing jumps the wait. */
import { depsError, depsReport, loadDeps, onDepsChange } from "../deps/state";
import { loadConfig, onConfigReloaded, onSettingsChanged, type VidarConfig } from "../config";
import { characterList, ensureCharacters, onCharactersChanged } from "../character/packs";
import type { Facts } from "./core";

/** Every fact id a declaration's `when.facts` may name. */
const NAMED_FACTS: Record<string, () => boolean> = {
  characters: () => hasCharacters(),
};
export const FACT_IDS: ReadonlySet<string> = new Set(Object.keys(NAMED_FACTS));

function hasCharacters(): boolean {
  return (characterList()?.packs.length ?? 0) > 0;
}

function offOverlay(cfg: VidarConfig): Set<string> {
  const overlay = cfg.capabilities;
  if (!overlay || typeof overlay !== "object") return new Set();
  return new Set(Object.entries(overlay).filter(([, v]) => v === false).map(([k]) => k));
}

function named(): Set<string> {
  return new Set(Object.entries(NAMED_FACTS).filter(([, present]) => present()).map(([id]) => id));
}

/** The config and facts one diff resolves against; reads caches only, never probes. */
export async function snapshot(): Promise<{ cfg: VidarConfig; facts: Facts }> {
  const cfg = (await loadConfig()).config;
  const report = depsReport();
  return {
    cfg,
    facts: {
      deps: report ? new Map(report.deps.map((d) => [d.id, d.found])) : null,
      packs: new Set(),
      config: cfg as Record<string, unknown>,
      facts: named(),
      off: offOverlay(cfg),
    },
  };
}

const listeners = new Set<() => void>();
let unwire: (() => void) | null = null;

function emit(): void {
  for (const fn of listeners) fn();
}

function wire(): () => void {
  let chars = hasCharacters();
  const unsubs = [
    onDepsChange(emit),
    onSettingsChanged(emit),
    onConfigReloaded(emit),
    onCharactersChanged(() => {
      const next = hasCharacters();
      if (next === chars) return;
      chars = next;
      emit();
    }),
  ];
  return () => { for (const u of unsubs) u(); };
}

/** One subscription over every fact source; returns the unsubscribe. */
export function onFactsChange(fn: () => void): () => void {
  listeners.add(fn);
  unwire ??= wire();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && unwire) {
      unwire();
      unwire = null;
    }
  };
}

/** The first waits, one per source, each bounded by the same `deadlineMs` and none rejecting.
 *  `deps` is dependency detection (a late or failed one leaves no report: fail open);
 *  `facts` maps each named fact id to its first probe (late or failed: absent, fail closed).
 *  Whatever lands late arrives through onFactsChange. */
export interface Settle {
  deps: Promise<void>;
  facts: ReadonlyMap<string, Promise<void>>;
}

export function settle(deadlineMs: number): Settle {
  const deadline = new Promise<void>((done) => setTimeout(done, deadlineMs));
  const bounded = (p: Promise<void>, what: string) =>
    Promise.race([p.catch((e: unknown) => console.error(`capability facts: ${what} failed`, e)), deadline]);
  // A settled detection (report or error) needs no wait; otherwise share the in-flight run
  // main.ts started (loadDeps starts one only if none ran).
  const deps = depsReport() || depsError() ? Promise.resolve() : loadDeps().then(() => {});
  // Fails closed: the panel stays hidden, so its "Characters Not Loaded" line never shows.
  const chars = ensureCharacters().then(() => {});
  return {
    deps: bounded(deps, "dependency detection"),
    facts: new Map([
      ["characters", bounded(chars, "list_characters")],
    ]),
  };
}
