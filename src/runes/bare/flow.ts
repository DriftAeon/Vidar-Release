// src\runes\bare\flow.ts — pure core of the Bare Runes tab (docs/runs/2026-10-17-bare-runes-flow, fold.md).
// No DOM, no IPC and no runtime imports, so `node --test` loads it: the view binds `BareFlowIo` to the
// bare_* and rules_import_* commands. States are keys; the view maps them to strings.
import type { ProgressEvent } from "./progress";

export type BareFileKind = "rules" | "memory" | "skill" | "agent" | "hook" | "mcp";
export type BareFileReason =
  | "pathScoped" | "notMjs" | "guardDriver"
  | "tooLarge" | "shadowed" | "summaryOnly" | "notHosted" | "stdio";
export interface BareGuard { event: string; matcher?: string; run: string[] }
export interface BareLocalFile {
  path: string; shown: string; kind: BareFileKind;
  library?: string; section?: string;
  scope: "global" | "project";
  ticked: boolean; pickable: boolean;
  reason?: BareFileReason;
  guard?: BareGuard;
  /** Absent = a Claude row. */
  agent?: "claude" | "codex";
  /** mcp rows: the hosted server name a pick writes to bareCodexMcp, and its pinned url. */
  hosted?: string; url?: string;
}
export interface BareLocalSources { files: BareLocalFile[]; memoryDir: string | null; guardsKey: boolean }

/** `path` is the rune file; a missing file gives "" and kind rule, activate always. */
export interface BareActiveBrick {
  id: string; section: string[]; studs: number; on: boolean;
  path: string; kind: string; activate: string; description: string; body: string;
}
/** Present on a library the agent generated (ipc.md `BareActiveLibraryGenerated`); `source` is null there. */
export interface BareGeneratedInfo {
  agent: "claude" | "codex"; model: string; effort: string; date: string;
  inputs: string[]; warnings: string[];
  encodedChars: number | null;
}
/** One set's layer sidecar (src-tauri/src/bare/actives.rs `ActiveSetLayer`; paths absolute). `editable`: the
 *  library sits under runtime\runes, so `setLayerWrite` takes it. `codexSkills` is the set's own, else its `skills`. */
export interface BareSetLayer {
  set: string; editable: boolean;
  skills: string[]; agents: string[]; guards: (BareGuard & { open?: string[] })[]; codexSkills: string[];
  warnings: string[];
}
/** `bare_set_layer_write`'s layer: a present key replaces the sidecar's, an absent one stays. */
export interface BareSetLayerWrite {
  skills?: string[]; agents?: string[]; guards?: (BareGuard & { open?: string[] })[]; codexSkills?: string[];
}
export interface BareActiveLibrary {
  library: string; source: string | null; scope: "global" | "project"; sourceGone: boolean;
  bricks: BareActiveBrick[];
  generated?: BareGeneratedInfo;
  /** Each set the row names in this library (absent from an older build = none). */
  sets?: BareSetLayer[];
}
export interface BareActives {
  rowKey: string; libraries: BareActiveLibrary[];
  skills: string[]; agents: string[]; guards: BareGuard[]; guardsKey: boolean;
  /** What bareCodexSkills, bareCodexAgents and bareCodexMcp hold (absent from an older build = none). */
  codexSkills?: string[]; codexAgents?: string[]; codexMcp?: string[];
}

// Shaped like RulesImportBrick / RulesImportScan / RulesImportApplied in src/ipc.ts.
export type BareBrickStatus = "new" | "known" | "gone" | "duplicate" | "profilePath";
export interface BareScanBrick {
  id: string; section: string[]; body: string; line: number; studs: number;
  status: BareBrickStatus; kept: boolean; rows: string[];
}
export interface BareScan { library: string; bricks: BareScanBrick[] }
export interface BareApplied { library: string; written: number; rows: string[] }

export interface BareLayerSet {
  guards?: BareGuard[]; skills?: string[]; agents?: string[];
  /** The Codex layer (bareCodexSkills, bareCodexAgents, bareCodexMcp); a refusal from Rust reaches the layer line as-is. */
  codexSkills?: string[]; codexAgents?: string[]; codexMcp?: string[];
}

/** The pinned rules_generate contract (docs/runs/2026-10-17-rune-generator/ipc.md). */
export interface RulesGenerateArgs {
  runId: string; rowKey: string; agent: "claude" | "codex"; model: string; effort: string;
  mergeEffort?: string;
  paths: string[]; cwd: string | null; budget: number | null;
}
export interface RulesGenerated {
  library: string; runes: number; on: number; encodedChars: number | null;
  costUsd: number | null; inputTokens: number | null; outputTokens: number | null;
  durationMs: number; warnings: string[];
}
export interface RulesGenerateToggleArgs { library: string; rowKey: string; id: string; on: boolean }

export interface BareFlowIo {
  generate(a: RulesGenerateArgs): Promise<RulesGenerated>;
  generateCancel(runId: string): Promise<unknown>;
  /** Subscribes to `rules-generate-progress`; resolves to the unsubscribe. Optional so fakes may omit it. */
  generateProgress?(fn: (e: ProgressEvent) => void): Promise<() => void>;
  generateToggle(a: RulesGenerateToggleArgs): Promise<BareApplied>;
  localSources(cwd: string): Promise<BareLocalSources>;
  actives(rowKey: string): Promise<BareActives>;
  scan(path: string, cwd: string): Promise<BareScan>;
  apply(a: { path: string; kept: string[]; rows: Record<string, string[]>; cwd: string }): Promise<BareApplied>;
  layerSet(a: BareLayerSet): Promise<{ written: string[] }>;
  /** `bare_set_layer_write`; optional so fakes may omit it (the set rows then stay read-only). */
  setLayerWrite?(a: { library: string; set: string; layer: BareSetLayerWrite }): Promise<unknown>;
}

export type LineState = "pending" | "running" | "done" | "failed";
export interface GenerateLine {
  /** The source path, or "layer" for the closing skills, agents and hooks write. */
  key: string;
  kind: "rules" | "memory" | "layer";
  state: LineState;
  error?: string;
}

export type ActionResult =
  | { ok: true }
  | { ok: false; reason: "readOnly" | "failed"; error?: string };

export interface LibraryDelta { library: string; added: number; gone: number; error?: string }

const errText = (e: unknown): string => String((e as { message?: string })?.message ?? e);
const guardKey = (g: BareGuard): string => JSON.stringify([g.event, g.matcher ?? null, g.run]);

/** Pure: the preselection the list starts from. */
export const defaultTicks = (files: readonly BareLocalFile[]): Set<string> =>
  new Set(files.filter((f) => f.ticked && f.pickable).map((f) => f.path));

/** Pure: the files one view lists. A Claude view drops `agent: "codex"` rows; a Codex view keeps only them. */
export const agentFiles = (files: readonly BareLocalFile[], codex: boolean): BareLocalFile[] =>
  files.filter((f) => (f.agent === "codex") === codex);

/** Pure: the Codex preselection (plan-q4 v3): rules files named AGENTS.md (any case) and the skills, agents
 *  (role `.toml` files) and hosted servers the scan ticks; memories start unticked and hooks are not offered. */
export const codexTicks = (files: readonly BareLocalFile[]): Set<string> =>
  new Set(files.filter((f) =>
    (f.kind === "rules" && f.pickable && /(^|[\\/])agents\.md$/i.test(f.path))
    || ((f.kind === "skill" || f.kind === "agent" || f.kind === "mcp") && f.ticked && f.pickable)).map((f) => f.path));

/** Pure: whether a brick may be kept at all (the profile path stays locked). */
const lockedBrick = (b: Pick<BareScanBrick, "status">): boolean => b.status === "profilePath";

/** Pure (fold 6): the `guards` to write, or undefined to leave bareGuards untouched.
 *  Block targets are ordinary hooks (on only when picked); entries the list does not offer round-trip
 *  unchanged; `[]` only when the user unticked every pickable hook. */
export function planGuards(
  files: readonly BareLocalFile[],
  ticked: ReadonlySet<string>,
  current: readonly BareGuard[],
): BareGuard[] | undefined {
  const hooks = files.filter((f) => f.kind === "hook" && f.guard);
  if (!hooks.length) return undefined;
  const offered = new Set(hooks.map((f) => guardKey(f.guard!)));
  const picked = hooks.filter((f) => f.pickable && ticked.has(f.path));
  const pickedKeys = new Set(picked.map((f) => guardKey(f.guard!)));
  const currentOffered = new Set(current.filter((g) => offered.has(guardKey(g))).map(guardKey));
  const same = pickedKeys.size === currentOffered.size && [...pickedKeys].every((k) => currentOffered.has(k));
  if (same) return undefined;
  const out: BareGuard[] = current.filter((g) => !offered.has(guardKey(g)));
  const seen = new Set<string>();
  for (const f of picked) {
    const k = guardKey(f.guard!);
    if (!seen.has(k)) { seen.add(k); out.push(f.guard!); }
  }
  if (!out.length) {
    if (!hooks.some((f) => f.pickable)) return undefined;
  }
  return out;
}

/** Pure: the row's On ids and the kept ids a library sync sends. `toggle` flips one brick; a brick turned
 *  On is also kept. New bricks join On and kept, gone ones leave, known ones keep their state (fold 13). */
export function syncPayload(
  lib: Pick<BareActiveLibrary, "bricks">,
  scan: BareScan,
  toggle?: { id: string; on: boolean },
): { kept: string[]; on: string[] } {
  const was = new Set(lib.bricks.filter((b) => b.on).map((b) => b.id));
  const on = new Set<string>();
  for (const b of scan.bricks) {
    if (b.status === "gone" || lockedBrick(b)) continue;
    if (b.status === "new" || was.has(b.id)) on.add(b.id);
  }
  if (toggle) {
    const b = scan.bricks.find((x) => x.id === toggle.id);
    if (b && b.status !== "gone" && !lockedBrick(b)) {
      if (toggle.on) on.add(toggle.id); else on.delete(toggle.id);
    }
  }
  const kept = new Set<string>(on);
  for (const b of scan.bricks) if (b.kept && b.status !== "gone" && !lockedBrick(b)) kept.add(b.id);
  return { kept: [...kept], on: [...on] };
}

// Per-rowKey single-flight (fold 11): module-wide, so two flows on one row still queue.
const tails = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const p = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  tails.set(key, p);
  const clear = (): void => { if (tails.get(key) === p) tails.delete(key); };
  p.then(clear, clear);
  return p;
}

// App-wide agent generation (ipc.md: one run at a time): runId -> rowKey, with watchers for the views.
const running = new Map<string, string>();
const watchers = new Set<() => void>();
const ping = (): void => { for (const w of [...watchers]) w(); };
/** True while any agent generation runs in this window. */
export const generating = (): boolean => running.size > 0;
/** True while a generation runs for this row (its switches and Import Raw stay off). */
export const rowGenerating = (rowKey: string | null | undefined): boolean =>
  !!rowKey && [...running.values()].includes(rowKey);
export function watchGenerating(fn: () => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

export const CODEX_BUDGET = 9000;
export const newRunId = (): string => Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

export type GenState = "done" | "failed" | "login" | "timeout" | "cancelled" | "rejected" | "stale" | "busy" | "readOnly";
export interface GenOutcome { state: GenState; runId: string; error?: string; result?: RulesGenerated }

/** Pure: the ipc.md error prefixes as an end state; `error` is the text after the prefix (for `rejected`,
 *  its first five lines). */
export function classifyGenError(raw: string): { state: Exclude<GenState, "done" | "readOnly">; error: string } {
  const s = raw.trim();
  const after = (p: string): string => s.slice(p.length).trim();
  if (s.startsWith("cancelled")) return { state: "cancelled", error: "" };
  if (s.startsWith("timeout")) return { state: "timeout", error: after("timeout").replace(/^:\s*/, "") };
  if (s.startsWith("stale:")) return { state: "stale", error: after("stale:") };
  if (s.startsWith("login:")) return { state: "login", error: after("login:") };
  if (s.startsWith("busy:")) return { state: "busy", error: after("busy:") };
  if (s.startsWith("invalid:")) return { state: "rejected", error: after("invalid:").split("\n").slice(0, 5).join("\n") };
  if (s.startsWith("spawn:")) return { state: "failed", error: after("spawn:") };
  if (s.startsWith("output:")) return { state: "failed", error: after("output:") };
  return { state: "failed", error: s };
}

/** The merge call's effort: `low` when the model offers it (Claude always does), else the run's own effort. */
export function mergeEffortFor(codex: boolean, effort: string, levels?: readonly string[]): string {
  return codex && levels && !levels.includes("low") ? effort : "low";
}

export interface GenerateAgentInput {
  sources: BareLocalSources;
  ticked: ReadonlySet<string>;
  model: string;
  effort: string;
  /** The chosen model's effort list (Codex: `codexEffortLevels`); the merge call needs `low` from it. */
  effortLevels?: readonly string[];
  /** Called with the run id as soon as the run is registered, so Cancel can name it. */
  onRun?(runId: string): void;
  /** Progress events of this run only (filtered by run id). */
  onProgress?(e: ProgressEvent): void;
}

export interface GenerateInput {
  sources: BareLocalSources;
  /** Ticked file paths (see `defaultTicks`). */
  ticked: ReadonlySet<string>;
  /** What bareGuards, bareSkills and bareAgents hold now (BareActives); leave off to always send. */
  current?: {
    guards: readonly BareGuard[]; skills: readonly string[]; agents: readonly string[];
    codexSkills?: readonly string[]; codexAgents?: readonly string[]; codexMcp?: readonly string[];
  };
  onLine?(lines: readonly GenerateLine[]): void;
}

export interface BareFlow {
  /** The last actives read, null before `load` or without a rowKey. */
  actives(): BareActives | null;
  /** False when the row has no rowKey: nothing below calls actives or apply. */
  readonly editable: boolean;
  load(): Promise<ActionResult>;
  generate(input: GenerateInput): Promise<GenerateLine[]>;
  /** The agent path (rules_generate); never rejects: failures are an end state. */
  generateAgent(input: GenerateAgentInput): Promise<GenOutcome>;
  cancelGenerate(runId: string): Promise<void>;
  toggleBrick(library: string, id: string, on: boolean): Promise<ActionResult>;
  /** Scans every writable library on the row and reports new and gone counts; writes nothing. */
  check(): Promise<LibraryDelta[]>;
  /** Update from Source (fold 13): re-scan and apply every writable library on the row. */
  update(): Promise<ActionResult>;
}

/** `codex`: the layer write sends `skills` only (a missing key leaves bareAgents and bareGuards untouched). */
export function createBareFlow(io: BareFlowIo, ctx: { rowKey?: string | null; cwd: string; codex?: boolean }): BareFlow {
  const rowKey = ctx.rowKey ? ctx.rowKey : null;
  let cache: BareActives | null = null;
  const run = <T>(fn: () => Promise<T>): Promise<T> => serial(rowKey ?? "", fn);

  const reload = async (): Promise<void> => { cache = await io.actives(rowKey!); };

  async function syncLibrary(lib: BareActiveLibrary, toggle?: { id: string; on: boolean }): Promise<void> {
    const scan = await io.scan(lib.source!, ctx.cwd);
    const { kept, on } = syncPayload(lib, scan, toggle);
    await io.apply({ path: lib.source!, kept, rows: { [rowKey!]: on }, cwd: ctx.cwd });
  }

  const writable = (): BareActiveLibrary[] => (cache?.libraries ?? []).filter((l) => l.source !== null);

  return {
    actives: () => cache,
    editable: rowKey !== null,
    load() {
      if (!rowKey) return Promise.resolve({ ok: false, reason: "readOnly" });
      return run(async (): Promise<ActionResult> => {
        try { await reload(); return { ok: true }; } catch (e) { return { ok: false, reason: "failed", error: errText(e) }; }
      });
    },
    generate(input) {
      const { sources, ticked } = input;
      const files = sources.files;
      const lines: GenerateLine[] = [];
      const jobs: { line: GenerateLine; path: string; drop: Set<string> }[] = [];
      for (const f of files) {
        if (f.kind === "rules" && ticked.has(f.path)) {
          const line: GenerateLine = { key: f.path, kind: "rules", state: "pending" };
          lines.push(line); jobs.push({ line, path: f.path, drop: new Set() });
        }
      }
      const memory = files.filter((f) => f.kind === "memory");
      if (sources.memoryDir && memory.some((f) => ticked.has(f.path))) {
        const line: GenerateLine = { key: sources.memoryDir, kind: "memory", state: "pending" };
        const drop = new Set(memory.filter((f) => !ticked.has(f.path) && f.section).map((f) => f.section!));
        lines.push(line); jobs.push({ line, path: sources.memoryDir, drop });
      }
      const layer: GenerateLine = { key: "layer", kind: "layer", state: "pending" };
      lines.push(layer);
      const emit = (): void => input.onLine?.(lines.map((l) => ({ ...l })));

      const body = async (): Promise<GenerateLine[]> => {
        emit();
        const keptOf = async (j: { path: string; drop: Set<string> }): Promise<string[]> => {
          const scan = await io.scan(j.path, ctx.cwd);
          return scan.bricks.filter((b) => b.kept && !lockedBrick(b) && !j.drop.has(b.section[0])).map((b) => b.id);
        };
        // Bare Codex has no length cap: every source applies on its own, like a Claude row.
        for (const j of jobs) {
          j.line.state = "running"; emit();
          try {
            const kept = await keptOf(j);
            await io.apply({ path: j.path, kept, rows: { [rowKey!]: kept }, cwd: ctx.cwd });
            j.line.state = "done";
          } catch (e) {
            j.line.state = "failed"; j.line.error = errText(e);
          }
          emit();
        }
        layer.state = "running"; emit();
        try {
          const set: BareLayerSet = {};
          const cur = input.current;
          const pick = (kind: "skill" | "agent"): string[] =>
            files.filter((f) => f.kind === kind && f.pickable && ticked.has(f.path)).map((f) => f.path);
          const same = (a: readonly string[], b: readonly string[]): boolean =>
            a.length === b.length && a.every((x) => b.includes(x));
          const skills = pick("skill"), agents = pick("agent");
          if (ctx.codex) {
            // without a current read an empty pick is not a change worth writing (it would wipe the list)
            if (cur ? !same(skills, cur.codexSkills ?? []) : skills.length) set.codexSkills = skills;
            // Codex role files go to codexAgents; `agents` (Claude .md files) is never sent from this view
            if (cur ? !same(agents, cur.codexAgents ?? []) : agents.length) set.codexAgents = agents;
            const offered = new Set(files.flatMap((f) => (f.kind === "mcp" && f.hosted ? [f.hosted] : [])));
            const picked = files.flatMap((f) => (f.kind === "mcp" && f.hosted && f.pickable && ticked.has(f.path) ? [f.hosted] : []));
            // servers the list does not offer round-trip unchanged
            const mcp = [...new Set([...(cur?.codexMcp ?? []).filter((n) => !offered.has(n)), ...picked])];
            if (cur ? !same(mcp, cur.codexMcp ?? []) : mcp.length) set.codexMcp = mcp;
          } else {
            if (!cur || !same(skills, cur.skills)) set.skills = skills;
            if (!cur || !same(agents, cur.agents)) set.agents = agents;
            const guards = planGuards(files, ticked, cur?.guards ?? []);
            if (guards) set.guards = guards;
          }
          if (Object.keys(set).length) await io.layerSet(set);
          layer.state = "done";
        } catch (e) { layer.state = "failed"; layer.error = errText(e); }
        try { await reload(); } catch { /* the view re-reads on load */ }
        emit();
        return lines;
      };
      if (!rowKey) {
        for (const l of lines) { l.state = "failed"; l.error = "readOnly"; }
        emit();
        return Promise.resolve(lines);
      }
      return run(body);
    },
    generateAgent(input) {
      const runId = newRunId();
      if (!rowKey) return Promise.resolve({ state: "readOnly", runId });
      if (running.size) return Promise.resolve({ state: "busy", runId });
      running.set(runId, rowKey); ping();
      input.onRun?.(runId);
      const { sources, ticked } = input;
      const paths = sources.files.filter((f) => f.kind === "rules" && ticked.has(f.path)).map((f) => f.path);
      if (sources.memoryDir && sources.files.some((f) => f.kind === "memory" && ticked.has(f.path))) paths.push(sources.memoryDir);
      return run(async (): Promise<GenOutcome> => {
        let unlisten: (() => void) | undefined;
        try {
          if (io.generateProgress) {
            try {
              unlisten = await io.generateProgress((e) => { if (e.runId === runId) input.onProgress?.(e); });
            } catch { /* progress is cosmetic; the run goes on without it */ }
          }
          const result = await io.generate({
            runId, rowKey, agent: ctx.codex ? "codex" : "claude", model: input.model, effort: input.effort,
            mergeEffort: mergeEffortFor(ctx.codex === true, input.effort, input.effortLevels),
            paths, cwd: ctx.cwd, budget: ctx.codex ? CODEX_BUDGET : null,
          });
          try { await reload(); } catch { /* the view re-reads on load */ }
          return { state: "done", runId, result };
        } catch (e) {
          const c = classifyGenError(errText(e));
          return { state: c.state, runId, error: c.error };
        } finally { running.delete(runId); unlisten?.(); ping(); }
      });
    },
    async cancelGenerate(runId) {
      try { await io.generateCancel(runId); } catch { /* a no-op past commit; the run's own result says what happened */ }
    },
    toggleBrick(library, id, on) {
      if (!rowKey) return Promise.resolve({ ok: false, reason: "readOnly" });
      return run(async (): Promise<ActionResult> => {
        const lib = cache?.libraries.find((l) => l.library === library);
        if (lib?.generated) {
          try {
            await io.generateToggle({ library, rowKey, id, on });
            await reload();
            return { ok: true };
          } catch (e) { return { ok: false, reason: "failed", error: errText(e) }; }
        }
        if (!lib || lib.source === null) return { ok: false, reason: "readOnly" };
        try {
          await syncLibrary(lib, { id, on });
          await reload();
          return { ok: true };
        } catch (e) { return { ok: false, reason: "failed", error: errText(e) }; }
      });
    },
    check() {
      if (!rowKey) return Promise.resolve([]);
      return run(async () => {
        const out: LibraryDelta[] = [];
        for (const lib of writable()) {
          try {
            const scan = await io.scan(lib.source!, ctx.cwd);
            out.push({
              library: lib.library,
              added: scan.bricks.filter((b) => b.status === "new").length,
              gone: scan.bricks.filter((b) => b.status === "gone").length,
            });
          } catch (e) { out.push({ library: lib.library, added: 0, gone: 0, error: errText(e) }); }
        }
        return out;
      });
    },
    update() {
      if (!rowKey) return Promise.resolve({ ok: false, reason: "readOnly" });
      return run(async (): Promise<ActionResult> => {
        let failed: string | null = null;
        for (const lib of writable()) {
          try { await syncLibrary(lib); } catch (e) { failed ??= errText(e); }
        }
        try { await reload(); } catch (e) { failed ??= errText(e); }
        return failed === null ? { ok: true } : { ok: false, reason: "failed", error: failed };
      });
    },
  };
}
