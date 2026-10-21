// src\modules\registry.ts — the module registry: one modules_list call, then moduleOn / modulesOf.
// In a release build (modules_list `set`), a non-core module needing a missing dep that ships inside
// Vidar is absent instead (`releaseAbsent`), with its dependants.
// Non-core modules whose dependsOn names an absent module go inactive ("Needs <id>"); the survivors
// run through the capability core's order() and resolve(), the one resolver (modules.md). Nothing
// here throws into main.ts: a failed IPC or a rejected ordering falls back to the core modules plus
// the bundled Codex declaration (no agent is core, so the fallback would otherwise hold none), plus
// a broken row; after a release build's good list, only the rows that list carried.
import coreContract from "../../contracts/modules.json" with { type: "json" };
import codexPack from "../../content/packs/codex/pack.json" with { type: "json" };
import { invoke } from "../ipc";
import { order, resolve, type CapabilityDecl, type Facts } from "../capabilities/core";
import { CATALOG, deadDeps, depsReport, isDetecting, loadDeps, mergePackDeps, onDepsChange, setReleaseBuild } from "../deps/state";
import { requireSoleAgentDep } from "../deps/sole-agent";
import type { DepEntry, DepReport } from "../deps/types";
import type { BrokenModule, ModuleDecl, ModuleSource, ModulesList } from "./types";

export type ModuleRow = ModuleDecl & { source: ModuleSource; folder?: string };

export interface ModuleView {
  row: ModuleRow;
  /** False when dropped for an absent dependency or turned off by an unmet `when`. */
  active: boolean;
  /** Why it is inactive ("Needs claude"). */
  reason?: string;
}

export interface BuiltModules {
  /** Registry order (dependsOn first), survivors only. */
  ordered: ModuleRow[];
  /** Every module, dropped ones included, for the Dependencies page. */
  dropped: ModuleView[];
  broken: BrokenModule[];
  /** Catalog entries the survivors contribute. */
  deps: DepEntry[];
}

const EMPTY: BuiltModules = { ordered: [], dropped: [], broken: [], deps: [] };

/** The compiled-in copy of content/packs/codex: the agent every fallback keeps, so a failed
 *  modules_list or a rejected ordering still yields one agent module. */
export const FALLBACK_AGENT: ModuleRow = { ...(codexPack.module as ModuleDecl), source: "pack", folder: "codex" };

/** Non-core-level modules (packs, and core[] rows at a pack level) with an
 *  absent module in their dependsOn closure, each with the absent id. A core-level module never
 *  drops: an absent dependency of one is an ordering error. */
function dropAbsent(rows: readonly ModuleRow[]): { kept: ModuleRow[]; dropped: ModuleView[] } {
  const present = new Set(rows.map((r) => r.id));
  const need = new Map<string, string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows) {
      if (r.level === "core" || need.has(r.id)) continue;
      for (const dep of r.dependsOn ?? []) {
        const root = !present.has(dep) ? dep : need.get(dep);
        if (root !== undefined) {
          need.set(r.id, root);
          changed = true;
          break;
        }
      }
    }
  }
  return {
    kept: rows.filter((r) => !need.has(r.id)),
    dropped: rows.filter((r) => need.has(r.id)).map((row) => ({ row, active: false, reason: `Needs ${need.get(row.id)}` })),
  };
}

const asCapability = (m: ModuleRow): CapabilityDecl => ({ ...m, when: m.when ?? {} });

/** Pure: modules_list -> ordered registry. `staticDepIds` are the catalog ids before any pack
 *  contributes. Never throws. */
export function buildModules(list: ModulesList, staticDepIds: ReadonlySet<string>): BuiltModules {
  const broken = [...list.broken];
  const { kept, dropped } = dropAbsent(list.modules);
  const deps = requireSoleAgentDep(kept, kept.flatMap((m) => m.deps ?? []));
  const depIds = new Set([...staticDepIds, ...deps.map((d) => d.id)]);
  try {
    return { ordered: order(kept.map(asCapability), depIds).map((c) => kept.find((m) => m.id === c.id)!), dropped, broken, deps };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    broken.push({ folder: "modules", reason });
    // The core modules plus one agent, tried in order: the listed codex pack, its compiled-in
    // copy, then none. The first that orders wins, so a listed codex row that is itself what
    // broke order() cannot empty the registry. Codex joins only when the merged catalog has a
    // codex dep row, so a set without the pack does not bring it back. A core[] row whose
    // dependsOn the fallback lacks drops like any other.
    const listed = kept.find((m) => m.id === FALLBACK_AGENT.id);
    const agents: ModuleRow[][] = depIds.has(FALLBACK_AGENT.id) ? [...(listed ? [[listed]] : []), [FALLBACK_AGENT], []] : [[]];
    for (const agent of agents) {
      const fallback = dropAbsent([...list.modules.filter((m) => m.source === "core"), ...agent]);
      const rows = fallback.kept;
      const rowIds = new Set(rows.map((m) => m.id));
      const offRows = [...dropped, ...fallback.dropped].filter((v, i, all) => !rowIds.has(v.row.id) && all.findIndex((w) => w.row.id === v.row.id) === i);
      const offIds = new Set(offRows.map((v) => v.row.id));
      const rest = kept.filter((m) => !rowIds.has(m.id) && !offIds.has(m.id)).map((row): ModuleView => ({ row, active: false, reason: "Registry Fallback" }));
      const fallbackDeps = rows.flatMap((m) => m.deps ?? []);
      const fallbackDepIds = new Set([...staticDepIds, ...fallbackDeps.map((d) => d.id)]);
      try {
        return { ordered: order(rows.map(asCapability), fallbackDepIds).map((c) => rows.find((m) => m.id === c.id)!), dropped: [...offRows, ...rest], broken, deps: fallbackDeps };
      } catch (e2) {
        if (agent !== agents[agents.length - 1]) continue;
        broken.push({ folder: "modules", reason: e2 instanceof Error ? e2.message : String(e2) });
        return { ordered: [], dropped: [...offRows, ...rows.map((row): ModuleView => ({ row, active: false, reason: "Registry Fallback" })), ...rest], broken, deps: [] };
      }
    }
    return { ordered: [], dropped, broken, deps: [] };
  }
}

/** Pure: the ids on for a dependency report (null = no report, every dependency reads found). */
export function resolveOn(ordered: readonly ModuleRow[], report: DepReport | null): Set<string> {
  const facts: Facts = {
    deps: report ? new Map(report.deps.map((d) => [d.id, d.found])) : null,
    packs: new Set(),
    config: {},
    facts: new Set(),
    off: new Set(),
  };
  return resolve(ordered.map(asCapability), facts);
}

/** Pure: the non-core modules a release build leaves out, as if its set never shipped them:
 *  those whose `when.deps` names a dead dep (deps/state.ts `releaseDeadDeps`: ships inside Vidar,
 *  reads missing), then those whose dependsOn names one of them, transitively. Core-level rows
 *  never drop. Empty when `dead` is (dev checkout, no report). */
export function releaseAbsent(rows: readonly ModuleRow[], dead: ReadonlySet<string>): Set<string> {
  const absent = new Set<string>();
  if (dead.size === 0) return absent;
  for (const r of rows) {
    if (r.level !== "core" && (r.when?.deps ?? []).some((d) => dead.has(d))) absent.add(r.id);
  }
  for (let changed = absent.size > 0; changed;) {
    changed = false;
    for (const r of rows) {
      if (r.level === "core" || absent.has(r.id) || !(r.dependsOn ?? []).some((d) => absent.has(d))) continue;
      absent.add(r.id);
      changed = true;
    }
  }
  return absent;
}

let built: BuiltModules = EMPTY;
let on = new Set<string>();
/** Ids `releaseAbsent` leaves out for the current report; re-derived on each resolve. */
let absent = new Set<string>();
let loaded = false;
/** The ids a release build's modules_list carried (its `set` filter applied); null in dev, on a
 *  fallback list with no earlier release list, and before the first load, so every id reads listed. */
let releaseIds: Set<string> | null = null;
let unsubscribeDeps: (() => void) | null = null;
const listeners = new Set<() => void>();
const staticIds = new Set(CATALOG.deps.map((d) => d.id));

function notify(): void {
  for (const fn of [...listeners]) {
    try { fn(); } catch (e) { console.error("modules listener failed", e); }
  }
}

function reresolve(): void {
  absent = releaseAbsent([...built.ordered, ...built.dropped.map((v) => v.row)], deadDeps());
  try {
    on = resolveOn(built.ordered, depsReport());
    for (const id of absent) on.delete(id);
  } catch (e) {
    console.error("module resolve failed", e);
    on = new Set();
  }
  notify();
}

/** The release set the last good modules_list carried: its id and the ids it listed. */
export interface ReleaseFilter { set: string; ids: ReadonlySet<string> }

/** The list a failed modules_list stands in with: the compiled core declarations
 *  (contracts/modules.json) and the bundled Codex agent, plus a broken row. With `release` (the
 *  last good list was a release set's), only the rows that list carried, and its set id, so a
 *  failed reload does not bring back modules the set left out. */
export function fallbackList(reason: string, release: ReleaseFilter | null = null): ModulesList {
  const core = (coreContract as unknown as { core: ModuleDecl[] }).core.map((m): ModuleRow => ({ ...m, source: "core" }));
  const broken = [{ folder: "modules", reason }];
  if (!release) return { modules: [...core, FALLBACK_AGENT], broken };
  const modules = [...core, FALLBACK_AGENT].filter((m) => m.level === "core" || release.ids.has(m.id));
  return { modules, broken, set: release.set };
}

/** Set by each successful modules_list; a failed one keeps it. */
let lastRelease: ReleaseFilter | null = null;

/** One modules_list call. Never rejects: a failed call falls back to `fallbackList`. */
export async function loadModules(): Promise<BuiltModules> {
  let list: ModulesList;
  try {
    list = await invoke("modules_list");
    lastRelease = list.set !== undefined ? { set: list.set, ids: new Set(list.modules.map((m) => m.id)) } : null;
  } catch (e) {
    console.error("modules_list failed", e);
    list = fallbackList(e instanceof Error ? e.message : String(e), lastRelease);
  }
  built = buildModules(list, staticIds);
  releaseIds = list.set !== undefined ? new Set(list.modules.map((m) => m.id)) : null;
  setReleaseBuild(list.set !== undefined);
  mergePackDeps(built.deps);
  // Detection may have captured the catalog before modules_list introduced pack deps.
  // Let that run settle, then refresh only when its report still omits a pack id.
  if (built.deps.length) {
    if (isDetecting()) await loadDeps();
    const reportedIds = new Set(depsReport()?.deps.map((dep) => dep.id));
    if (built.deps.some((dep) => !reportedIds.has(dep.id))) await loadDeps();
  }
  loaded = true;
  unsubscribeDeps ??= onDepsChange(reresolve);
  reresolve();
  return built;
}

/** False before loadModules settles, for an unknown id, a dropped module or an unmet `when`. */
export function moduleOn(id: string): boolean {
  return loaded && on.has(id);
}

/** Does a release build ship this module? True before the list resolves and in dev (no `set`), so
 *  first paint and dev builds keep every compiled core[] surface; in a release build, true only
 *  for ids the set's modules_list carried that `releaseAbsent` does not leave out. Surfaces built
 *  from contracts/modules.json core[] (bench tabs, toolbar tools, Settings › Modules) gate on it. */
export function moduleListed(id: string): boolean {
  return releaseIds === null || (releaseIds.has(id) && !absent.has(id));
}

/** Active modules of one kind, registry order. */
export function modulesOf(kind: ModuleDecl["kind"]): ModuleRow[] {
  return built.ordered.filter((m) => m.kind === kind && on.has(m.id));
}

/** Pure: is this row a gateway (kind agent with `agent.gateway`)? Says nothing of `when`. */
export const isGatewayRow = (m: ModuleRow): boolean => m.kind === "agent" && !!m.agent?.gateway;

/** Pure: the gateway rows among registry-ordered rows (survivors only, so a module dropped for an
 *  absent dependency is not one; an unmet `when` still is). */
export function gatewayRows(ordered: readonly ModuleRow[]): ModuleRow[] {
  return ordered.filter(isGatewayRow);
}

/** The one answer to "this id is a gateway": present (not dropped), kind agent with `agent.gateway`,
 *  whatever its `when`. Launch availability (`requires`) is a separate concern. */
export function gatewayModuleRows(): ModuleRow[] {
  return gatewayRows(built.ordered).filter((m) => !absent.has(m.id));
}

/** Every module row with its state, for the Dependencies page; a release build's absent rows are not listed. */
export function moduleViews(): ModuleView[] {
  return [
    ...built.ordered.map((row): ModuleView => ({ row, active: on.has(row.id) })),
    ...built.dropped,
  ].filter((v) => !absent.has(v.row.id));
}

export function brokenModules(): readonly BrokenModule[] {
  return built.broken;
}

export function modulesLoaded(): boolean {
  return loaded;
}

/** Fires after load and after each re-resolve. Returns the unsubscribe. */
export function onModulesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
