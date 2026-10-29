// Add Kit turns selected local items into library item runes, then places the Kit runeset in the vault.
import { agentFiles, type BareFlowIo, type BareLocalFile, type BareModuleBundles, type ItemRuneInputs } from "./flow";
import type { VaultOp } from "../../ipc";
import type { AgentId } from "../../agents/id";

/** Path and module inputs consumed by item-rune creation; no set layer is written. */
export function itemRuneInputs(files: readonly BareLocalFile[], picked: ReadonlySet<string>,
  bundles: BareModuleBundles | null, codex: boolean): ItemRuneInputs {
  const selected = agentFiles(files, codex).filter((f) => f.pickable && picked.has(f.path));
  const skills = selected.filter((f) => f.kind === "skill").map((f) => f.path);
  const agents = selected.filter((f) => f.kind === "agent").map((f) => f.path);
  const guards = selected.filter((f) => f.kind === "hook" && f.guard && f.guard.command === undefined)
    .map((f) => ({ event: f.guard!.event, ...(f.guard!.matcher ? { matcher: f.guard!.matcher } : {}),
      ...(f.guard!.run ? { run: f.guard!.run } : {}), ...(f.guard!.source ? { source: f.guard!.source } : {}) }));
  const servers = new Set(selected.filter((f) => f.kind === "mcp" && f.hosted).map((f) => f.hosted!));
  const modules: NonNullable<ItemRuneInputs["modules"]> = {};
  for (const [id, bundle] of Object.entries(bundles?.bundles ?? {})) {
    if (!bundle.mcp.some((m) => servers.has(m.name))) continue;
    modules[id] = { off: [
      ...bundle.mcp.filter((m) => !servers.has(m.name)).map((m) => `mcp:${m.name}`),
      ...bundle.skills.map((p) => `skill:${p.split(/[\\/]/).at(-1)?.toLowerCase()}`),
      ...bundle.agents.map((p) => `agent:${p.split(/[\\/]/).at(-1)?.toLowerCase()}`),
      ...bundle.guards.map((g) => `guard:${g.event}|${g.matcher ?? ""}|${(g.run ?? []).map((p) => p.split(/[\\/]/).at(-1)?.toLowerCase()).join(",")}`),
    ] };
  }
  return {
    ...(skills.length ? { skills } : {}),
    ...(agents.length ? codex ? { codexAgents: agents } : { agents } : {}),
    ...(guards.length ? codex ? { codexGuards: guards } : { guards } : {}),
    ...(Object.keys(modules).length ? { modules } : {}),
  };
}

export function kitItems(files: readonly BareLocalFile[], bundles: BareModuleBundles | null): ItemRuneInputs {
  const picked = new Set(files.filter((f) => f.pickable && ["skill", "agent", "hook", "mcp"].includes(f.kind)).map((f) => f.path));
  const claude = itemRuneInputs(files, picked, bundles, false);
  const codex = itemRuneInputs(files, picked, bundles, true);
  const modules = { ...claude.modules };
  for (const [id, tick] of Object.entries(codex.modules ?? {})) {
    modules[id] = modules[id] ? { off: modules[id].off.filter((key) => tick.off.includes(key)) } : tick;
  }
  return {
    ...([...(claude.skills ?? []), ...(codex.skills ?? [])].length ? { skills: [...new Set([...(claude.skills ?? []), ...(codex.skills ?? [])])] } : {}),
    ...(claude.agents?.length ? { agents: claude.agents } : {}),
    ...(claude.guards?.length ? { guards: claude.guards } : {}),
    ...(codex.codexAgents?.length ? { codexAgents: codex.codexAgents } : {}),
    ...(codex.codexGuards?.length ? { codexGuards: codex.codexGuards } : {}),
    ...(Object.keys(modules).length ? { modules } : {}),
  };
}

export const KIT_OPS: VaultOp[] = [{ op: "addRuneset", ref: { library: "kit", set: "kit" } }];
/** The base Kit set, plus `kit-<agent>` when the Kit library holds it; a missing agent set is skipped. */
export function kitOps(agent: AgentId | undefined, sets: readonly { library?: string; set: string }[]): VaultOp[] {
  const own = agent ? `kit-${agent}` : null;
  if (!own || !sets.some((s) => s.library === "kit" && s.set === own)) return KIT_OPS;
  return [...KIT_OPS, { op: "addRuneset", ref: { library: "kit", set: own } }];
}
export async function addKit(io: BareFlowIo, cwd: string, bundles: BareModuleBundles | null, agent?: AgentId):
  Promise<{ created: boolean; skipped: number; ops: VaultOp[] }> {
  if (!io.kitCreate) throw new Error("Add Kit is unavailable");
  const sources = await io.localSources(cwd);
  const result = await io.kitCreate({ layer: kitItems(sources.files, bundles) });
  const sets = await io.kitSets?.().catch(() => []) ?? [];
  return { created: result.created, skipped: result.dropped.length, ops: kitOps(agent, sets) };
}
