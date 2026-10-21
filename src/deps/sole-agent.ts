// src\deps\sole-agent.ts — the dep of a set's only agent counts as required. Pure: no IPC, no DOM.
// A pack declares its CLI `required: false` (with Claude and Codex both shipped, either alone is
// enough); when the modules a build lists hold exactly one agent, that agent's setup dep is the
// product's one way in, so the Dependencies page lists it under Required.
import type { DepEntry } from "./types";
import type { ModuleDecl } from "../modules/types";

/** `deps` (the entries `modules` contribute) with the setup dep of the one listed agent module
 *  marked `required`. Unchanged when the list holds no agent or more than one, or the agent names
 *  no setup dep. Returns copies for the changed entry; never mutates a pack declaration. */
export function requireSoleAgentDep(modules: readonly Pick<ModuleDecl, "kind" | "agent">[], deps: readonly DepEntry[]): DepEntry[] {
  const agents = modules.filter((m) => m.kind === "agent");
  const dep = agents.length === 1 ? agents[0].agent?.setup?.dep : undefined;
  if (dep === undefined) return [...deps];
  return deps.map((d) => (d.id === dep && !d.required ? { ...d, required: true } : d));
}
