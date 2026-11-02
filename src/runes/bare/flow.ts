// Source discovery and Generate for Runes. Session content comes from the Rune Vault.
import type { ProgressEvent } from "./progress";
import type { AgentId } from "../../agents/id";
// @ts-ignore TS5097: node --test loads this module directly
import { AGENT_IDS } from "../../agents/id.ts";
// @ts-ignore TS5097: node --test loads this module directly
import { AGENTS } from "../../agents/descriptor.ts";
// @ts-ignore TS5097: node --test loads this module directly
import { errText } from "../../err-text.ts";
import type { SessionVault, VaultView } from "./cake";

import type {
  BareFileKind, BareFileReason, BareGuard, BareModuleBundle, BareModuleBundles, RulesGenerateArgs, RulesGenerated,
} from "../../ipc";

// The wire types below live in src/ipc.ts; consumers keep importing them from here.
export type { BareFileKind, BareModuleBundle, BareModuleBundles };
// BareLocalFile stays separate from ipc.ts: this copy types guards as BareGuard (run optional)
// and adds codexSupported; ipc.ts's guard needs run, and its item guards carry `open`.
export interface BareLocalFile {
  path: string; shown: string; kind: BareFileKind; library?: string; section?: string;
  scope: "global" | "project"; ticked: boolean; pickable: boolean; reason?: BareFileReason;
  guard?: BareGuard; codexSupported?: boolean; agent?: AgentId; hosted?: string; url?: string;
}
export interface BareLocalSources { files: BareLocalFile[]; memoryDir: string | null; guardsKey: boolean }
/** Card data derived from a vault view. Kept for shared card helpers. */
export interface BareActiveBrick {
  id: string; section: string[]; studs: number; on: boolean; state: "off" | "on" | "shadow";
  required?: boolean; path: string; kind: string; activate: string;
  description: string; body: string; origin?: string; closesWhen?: string; why?: string; example?: string; paths?: string[];
}
export interface BareSetLayer {
  set: string;
}
export interface BareActiveLibrary {
  library: string; source: string | null; scope: "global" | "project"; sourceGone: boolean;
  bricks: BareActiveBrick[]; sets?: BareSetLayer[];
  generated?: { agent: AgentId; model: string; effort: string; date: string; inputs: string[]; warnings: string[]; encodedChars: number | null };
}
export interface BareFlowIo {
  localSources(cwd: string): Promise<BareLocalSources>;
  moduleBundles?(): Promise<BareModuleBundles>;
  readText?(path: string): Promise<string>;
  generate(a: RulesGenerateArgs): Promise<RulesGenerated>;
  generateCancel(runId: string): Promise<unknown>;
  generateProgress?(fn: (e: ProgressEvent) => void): Promise<() => void>;
}
export type ActionResult = { ok: true } | { ok: false; reason: "readOnly" | "failed"; error?: string };
export const defaultTicks = (files: readonly BareLocalFile[]): Set<string> =>
  new Set(files.filter((f) => f.ticked && f.pickable).map((f) => f.path));
/** Accept the old boolean at pure helper boundaries while callers pass AgentId. */
const sourceAgent = (agent: AgentId | boolean): AgentId => {
  if (typeof agent !== "boolean") return agent;
  const id = AGENT_IDS.find((candidate) => AGENTS[candidate].flowSdk !== agent);
  if (!id) throw new Error("No agent for source capability");
  return id;
};
/** Old direct callers used a boolean property named after the non-SDK agent. */
export const inputAgent = (input: { agent?: AgentId } & Record<string, unknown>): AgentId =>
  input.agent ?? AGENT_IDS.find((id) => !AGENTS[id].flowSdk && input[id] === true)
    ?? AGENT_IDS.find((id) => AGENTS[id].flowSdk)!;
export const agentFiles = (files: readonly BareLocalFile[], agent: AgentId | boolean): BareLocalFile[] => {
  const id = sourceAgent(agent);
  return files.filter((f) => f.agent === id || (AGENTS[id].flowSdk && f.agent === undefined));
};
export const nonSdkTicks = (files: readonly BareLocalFile[], agent: AgentId = AGENT_IDS.find((id) => !AGENTS[id].flowSdk)!): Set<string> =>
  new Set(files.filter((f) =>
    (f.kind === "rules" && f.pickable && f.path.replace(/\\/g, "/").toLowerCase().endsWith(`/${AGENTS[agent].instructionsFile.toLowerCase()}`)) ||
    ((f.kind === "skill" || f.kind === "agent" || f.kind === "mcp") && f.ticked && f.pickable)).map((f) => f.path));

const running = new Set<string>();
const watchers = new Set<() => void>();
const ping = (): void => { for (const fn of watchers) fn(); };
export const generating = (): boolean => running.size > 0;
export function watchGenerating(fn: () => void): () => void { watchers.add(fn); return () => { watchers.delete(fn); }; }
export const newRunId = (): string => Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
export type GenState = "done" | "failed" | "login" | "timeout" | "cancelled" | "rejected" | "stale" | "busy" | "readOnly";
export interface GenOutcome { state: GenState; runId: string; error?: string; result?: RulesGenerated }
export function classifyGenError(raw: string): { state: Exclude<GenState, "done" | "readOnly">; error: string } {
  const s = raw.trim(), after = (p: string): string => s.slice(p.length).trim().replace(/^:\s*/, "");
  if (s.startsWith("cancelled")) return { state: "cancelled", error: "" };
  if (s.startsWith("timeout")) return { state: "timeout", error: after("timeout") };
  if (s.startsWith("stale:")) return { state: "stale", error: after("stale:") };
  if (s.startsWith("login:")) return { state: "login", error: after("login:") };
  if (s.startsWith("busy:")) return { state: "busy", error: after("busy:") };
  if (s.startsWith("invalid:")) return { state: "rejected", error: after("invalid:").split("\n").slice(0, 5).join("\n") };
  if (s.startsWith("budget:")) return { state: "failed", error: `Stopped at the Budget Cap: ${after("budget:")}` };
  if (s.startsWith("spawn:")) return { state: "failed", error: after("spawn:") };
  if (s.startsWith("output:")) return { state: "failed", error: after("output:") };
  return { state: "failed", error: s };
}
export function mergeEffortFor(agent: AgentId | boolean, effort: string, levels?: readonly string[]): string {
  return !AGENTS[sourceAgent(agent)].flowSdk && levels && !levels.includes("low") ? effort : "low";
}
export interface GenerateAgentInput {
  sources: BareLocalSources; ticked: ReadonlySet<string>; model: string; effort: string; effortLevels?: readonly string[];
  onRun?(runId: string): void; onProgress?(e: ProgressEvent): void;
}
export interface BareFlow {
  load(): Promise<SessionVault | null>;
  generateAgent(input: GenerateAgentInput): Promise<GenOutcome>;
  cancelGenerate(runId: string): Promise<void>;
}
export function createBareFlow(io: BareFlowIo, ctx: {
  cwd: string; agent?: AgentId; session?: () => Promise<{ vault: { id: string; hash: string } } | null>;
  read?: (id: string, hash: string, agent?: string) => Promise<VaultView>;
  [key: string]: unknown;
}): BareFlow {
  return {
    async load() {
      const record = await ctx.session?.();
      return record && ctx.read ? { session: record as SessionVault["session"],
        view: await ctx.read(record.vault.id, record.vault.hash, ctx.agent) } : null;
    },
    async generateAgent(input) {
      const runId = newRunId();
      if (running.size) return { state: "busy", runId };
      running.add(runId); ping(); input.onRun?.(runId);
      const { sources, ticked } = input;
      const paths = sources.files.filter((f) => f.kind === "rules" && ticked.has(f.path)).map((f) => f.path);
      if (sources.memoryDir && sources.files.some((f) => f.kind === "memory" && ticked.has(f.path))) paths.push(sources.memoryDir);
      const items = sources.files.filter((f) => (f.kind === "skill" || f.kind === "agent" || f.kind === "hook") && f.pickable && ticked.has(f.path))
        .map((f) => ({ kind: f.kind as "skill" | "agent" | "hook", path: f.path }));
      let unlisten: (() => void) | undefined;
      try {
        if (io.generateProgress) {
          try { unlisten = await io.generateProgress((e) => { if (e.runId === runId) input.onProgress?.(e); }); }
          catch { /* Progress is cosmetic. */ }
        }
        const agent = inputAgent(ctx);
        const result = await io.generate({ runId, agent, model: input.model,
          effort: input.effort, mergeEffort: mergeEffortFor(agent, input.effort, input.effortLevels),
          paths, ...(items.length ? { items } : {}), cwd: ctx.cwd });
        return { state: "done", runId, result };
      } catch (e) { return { ...classifyGenError(errText(e)), runId }; }
      finally { running.delete(runId); unlisten?.(); ping(); }
    },
    async cancelGenerate(runId) { try { await io.generateCancel(runId); } catch { /* The run reports its own result. */ } },
  };
}
