// Settings > Build, pure state: the toggle list from release-build.ps1's catalog, the dependsOn
// closure, and the run model folded from `release-build-event` lines. No DOM, no IPC
// (tests/release-build-state.test.mjs imports it directly).
import type {
  ReleaseBuildCatalog, ReleaseBuildEvent, ReleaseBuildModule, ReleaseBuildPhase, ReleaseBuildResult, ReleaseBuildSet,
} from "../../ipc-settings";

export type GroupTitle = "Agents" | "Content" | "Surfaces";
export interface Toggle { id: string; label: string; group: GroupTitle; dependsOn: string[] }

/** The log tail the Building and Failure views show. */
export const TAIL_LINES = 8;

/** Core modules ship in every set, so they are never toggles. Catalog order is kept. */
export function toggles(catalog: ReleaseBuildCatalog): Toggle[] {
  return catalog.modules.filter((m) => m.level !== "core").map((m: ReleaseBuildModule) => ({
    id: m.id, label: m.label, dependsOn: Array.isArray(m.dependsOn) ? m.dependsOn : [],
    group: m.kind === "agent" ? "Agents" : m.kind === "surface" ? "Surfaces" : "Content",
  }));
}

export const GROUPS: GroupTitle[] = ["Agents", "Content", "Surfaces"];

/** The toggles a set starts with: `*` is every toggle; ids the catalog lacks are dropped. */
export function setOn(set: ReleaseBuildSet | undefined, list: Toggle[]): Set<string> {
  if (!set) return new Set();
  if (set.include.includes("*")) return new Set(list.map((t) => t.id));
  const known = new Set(list.map((t) => t.id));
  return new Set(set.include.filter((id) => known.has(id)));
}

/** A parent that is not a toggle (a core module) always ships. */
function byId(list: Toggle[]): Map<string, Toggle> {
  return new Map(list.map((t) => [t.id, t]));
}

/** Toggles that will be dropped by the resolver: on, but a parent (at any depth) is off or dropped.
 *  The value is the label of the first such parent, for the "Needs <Label>" tooltip. Off toggles
 *  whose parent is off are dimmed too, so turning them on is seen to pull the parent in. */
export function dimmed(on: ReadonlySet<string>, list: Toggle[]): Map<string, string> {
  const map = byId(list);
  const live = new Map<string, boolean>();
  const isLive = (id: string, seen: Set<string>): boolean => {
    const t = map.get(id);
    if (!t) return true;
    if (live.has(id)) return live.get(id)!;
    if (seen.has(id)) return false;
    seen.add(id);
    const ok = on.has(id) && t.dependsOn.every((p) => isLive(p, seen));
    live.set(id, ok);
    return ok;
  };
  const out = new Map<string, string>();
  for (const t of list) {
    const missing = t.dependsOn.find((p) => !isLive(p, new Set()));
    if (missing !== undefined) out.set(t.id, map.get(missing)?.label ?? missing);
  }
  return out;
}

/** Flips one toggle. Off leaves dependants as they are (they dim); on also turns on every parent
 *  it needs, transitively. Returns a new set. */
export function flip(on: ReadonlySet<string>, id: string, list: Toggle[]): Set<string> {
  const next = new Set(on);
  if (next.has(id)) {
    next.delete(id);
    return next;
  }
  const map = byId(list);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (next.has(cur) || !map.has(cur)) continue;
    next.add(cur);
    stack.push(...map.get(cur)!.dependsOn);
  }
  return next;
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/** The include list release_build_start takes, in catalog order. */
export function includeList(on: ReadonlySet<string>, list: Toggle[]): string[] {
  return list.filter((t) => on.has(t.id)).map((t) => t.id);
}

export interface RunModel { phase: ReleaseBuildPhase | null; log: string[]; result: ReleaseBuildResult | null }

export function emptyRun(): RunModel {
  return { phase: null, log: [], result: null };
}

/** Folds one protocol line into the run. The log keeps TAIL_LINES. */
export function applyEvent(run: RunModel, ev: ReleaseBuildEvent): RunModel {
  if (ev.t === "phase") return { ...run, phase: ev.phase };
  if (ev.t === "log") return { ...run, log: [...run.log, String(ev.line)].slice(-TAIL_LINES) };
  if (ev.t === "result") return { ...run, result: ev };
  return run;
}

export function replay(events: ReleaseBuildEvent[]): RunModel {
  return events.reduce(applyEvent, emptyRun());
}

const PHASE_LABEL: Record<ReleaseBuildPhase, string> = {
  check: "Checking", build: "Building", zip: "Zipping", trace: "Tracing", done: "Tracing",
};

export function phaseLabel(phase: ReleaseBuildPhase | null): string {
  return phase ? PHASE_LABEL[phase] ?? "Checking" : "Checking";
}

/** mm:ss, or h:mm:ss past an hour. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h ? `${h}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** The wrapper serializes a one-item array as a bare string; both read as a list. */
export function droppedIds(result: ReleaseBuildResult): string[] {
  const d: unknown = result.dropped;
  if (Array.isArray(d)) return d.map(String);
  return typeof d === "string" && d ? [d] : [];
}

export interface ResultSummary { zipName: string; size: string; trace: string; gaps: string; dropped: string; personal: string }

export function summarize(result: ReleaseBuildResult, list: Toggle[]): ResultSummary {
  const labels = new Map(list.map((t) => [t.id, t.label]));
  const dropped = droppedIds(result).map((id) => labels.get(id) ?? id);
  return {
    zipName: (result.zip ?? "").split(/[\\/]/).pop() ?? "",
    size: typeof result.sizeMb === "number" ? `${result.sizeMb} MB` : "",
    trace: result.trace === "pass" ? "Trace Pass" : result.trace === "fail" ? "Trace Fail" : "",
    gaps: typeof result.gapHigh === "number" ? `${result.gapHigh} High Gaps` : "",
    dropped: dropped.length ? `Dropped ${dropped.join(", ")}` : "",
    // release-build.ps1 sets `personal` for a full or gateway-pack set: the zip is for this machine only (E2).
    personal: result.personal === true ? "Personal Build, Do Not Share" : "",
  };
}

/** The one failure line: Cancelled, else the backend's error as given. */
export function failureLine(result: ReleaseBuildResult): string {
  return result.cancelled ? "Cancelled" : result.error || "Build Failed";
}
