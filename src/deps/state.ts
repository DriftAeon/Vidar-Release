// src\deps\state.ts — the dependency catalog and the last detect result.
// One concern: the report cache. No DOM, no settings, no launcher imports; the page, the setup
// agent and the launcher filter read through these functions and listen with onDepsChange.
import { invoke } from "../ipc";
import catalog from "../../contracts/dependencies.json" with { type: "json" };
import type { DepCatalog, DepEntry, DepProbe, DepReport } from "./types";

const PROBE_KINDS: ReadonlySet<string> = new Set<DepProbe["kind"]>(["exe", "vidar", "config", "env", "falcon"]);

/** The JSON import widens `probe.kind` to string: check every kind against DepProbe's five and
 *  throw at module load on an unknown one, so a catalog edit fails loudly instead of casting. */
function checkCatalog(raw: { version: number; deps: Array<Omit<DepEntry, "probe"> & { probe: { kind: string } }> }): DepCatalog {
  for (const dep of raw.deps) {
    if (!PROBE_KINDS.has(dep.probe.kind)) {
      throw new Error(`contracts/dependencies.json: dep "${dep.id}" has unknown probe kind "${dep.probe.kind}"`);
    }
  }
  return raw as DepCatalog;
}

export const CATALOG: DepCatalog = checkCatalog(catalog);

const STATIC_COUNT = CATALOG.deps.length;

/** Appends the catalog entries pack modules contribute (modules_list `deps[]`), in place so every
 *  holder of CATALOG sees them. Idempotent: the static entries stay first, the previous merge is
 *  replaced, and an id the static catalog already has keeps the static entry. */
export function mergePackDeps(extra: readonly DepEntry[]): void {
  const staticIds = new Set(CATALOG.deps.slice(0, STATIC_COUNT).map((d) => d.id));
  const seen = new Set<string>();
  const merged: DepEntry[] = [];
  for (const d of extra) {
    if (staticIds.has(d.id) || seen.has(d.id)) continue;
    seen.add(d.id);
    merged.push(d);
  }
  CATALOG.deps.splice(STATIC_COUNT, CATALOG.deps.length - STATIC_COUNT, ...merged);
}

let report: DepReport | null = null;
let error: string | null = null;
let inFlight: Promise<DepReport | null> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) {
    try { fn(); } catch (e) { console.error("deps listener failed", e); }
  }
}

/** Runs detection once at a time: callers during a run share its promise. Success caches the
 *  report and clears the error; failure keeps the previous report, sets depsError and resolves
 *  null. Both notify. */
export function loadDeps(): Promise<DepReport | null> {
  if (inFlight) return inFlight;
  inFlight = invoke("detect_dependencies")
    .then((r): DepReport | null => {
      report = r;
      error = null;
      return r;
    }, (e: unknown): DepReport | null => {
      console.error("detect_dependencies failed", e);
      error = e instanceof Error ? e.message : String(e);
      return null;
    })
    .finally(() => {
      inFlight = null;
      notify();
    });
  return inFlight;
}

/** True while a detect_dependencies run is in flight. */
export function isDetecting(): boolean {
  return inFlight !== null;
}

export function depsReport(): DepReport | null {
  return report;
}

export function depsError(): string | null {
  return error;
}

/** True when there is no report yet, or the report has the id and it was found. */
export function isAvailable(id: string): boolean {
  if (!report) return true;
  return report.deps.find((d) => d.id === id)?.found ?? false;
}

/** Strict twin of `isAvailable`: null before the first report; after it, whether the dep row with
 *  this id was found (pack deps included), false for an id the report lacks. */
export function depFound(id: string): boolean | null {
  if (!report) return null;
  return report.deps.find((d) => d.id === id)?.found ?? false;
}

function isFound(id: string): boolean {
  return report?.deps.find((d) => d.id === id)?.found ?? false;
}

let releaseBuild = false;

/** Set from modules_list's `set` on each registry load: true in a release build of a set. */
export function setReleaseBuild(on: boolean): void {
  releaseBuild = on;
}

/** Pure: in a release build, the ids of `probe.kind` "vidar" deps (files that ship inside Vidar,
 *  nothing the user can install) the report reads missing. Empty outside a release build or
 *  without a report. */
export function releaseDeadDeps(deps: readonly DepEntry[], rep: DepReport | null, release: boolean): Set<string> {
  if (!release || !rep) return new Set();
  const found = new Map(rep.deps.map((d) => [d.id, d.found]));
  return new Set(deps.filter((d) => d.probe.kind === "vidar" && found.get(d.id) === false).map((d) => d.id));
}

/** The ids `releaseDeadDeps` gives for the live catalog and report. */
export function deadDeps(): Set<string> {
  return releaseDeadDeps(CATALOG.deps, report, releaseBuild);
}

/** Catalog entries the Dependencies page lists: all but the release build's dead ones. */
export function shownDeps(): DepEntry[] {
  const dead = deadDeps();
  return CATALOG.deps.filter((d) => !dead.has(d.id));
}

/** Required and not found; [] with no report. */
export function missingRequired(): DepEntry[] {
  if (!report) return [];
  return shownDeps().filter((d) => d.required && !isFound(d.id));
}

/** Every entry not found, in catalog order; [] with no report. */
export function missingEntries(): DepEntry[] {
  if (!report) return [];
  return shownDeps().filter((d) => !isFound(d.id));
}

/** Fires after every detection, success or failure. Returns the unsubscribe. */
export function onDepsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
