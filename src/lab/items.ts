// Which runes the Lab lists, and which history rows belong to which agent. Pure (no DOM) so a test
// can import it; `isOn` is the module registry's `moduleOn`, injected.
import type { RuneItem, RuneLibraryKey, RuneSet } from "../runes/types";
// @ts-ignore TS5097: node --test loads this pure module directly
import { AGENTS } from "../agents/descriptor.ts";
// @ts-ignore TS5097: node --test loads this pure module directly
import { AGENT_IDS } from "../agents/id.ts";
import type { AgentId } from "../agents/id.ts";

/** An agent's project instructions file name (`AGENTS[id].instructionsFile`). */
export type LabTarget = string;

export interface LabRuneItem {
  rune: RuneItem;
  target: LabTarget;
}

export interface LabGroup {
  lib: RuneLibraryKey;
  items: LabRuneItem[];
}

export interface LabLibraryLike {
  key: RuneLibraryKey;
  runes: RuneItem[];
  sets: Pick<RuneSet, "target" | "members">[];
}

export const CODEX_TOOLS_ERROR = "Codex Cases Cannot Set Tools";

const agentForTarget = (target: string): AgentId | null => {
  const file = target.split(/[\\/]/).at(-1);
  return AGENT_IDS.find((id) => AGENTS[id].instructionsFile.toLowerCase() === file?.toLowerCase()) ?? null;
};

/** Runes that are members of a set targeting CLAUDE.md (agent `claude` on) or AGENTS.md (agent `codex` on),
 *  per library in catalog order; a rune in both gives a Claude item then a Codex item. Other targets
 *  (`.claude/rules/*`, plugins) are not Lab items. */
export function labItems(libs: LabLibraryLike[], isOn: (id: string) => boolean): LabGroup[] {
  const enabled = new Set(AGENT_IDS.filter(isOn));
  return libs.map((l) => {
    const members: Record<AgentId, Set<string>> = { claude: new Set(), codex: new Set() };
    for (const s of l.sets) {
      const t = s.target;
      if (!t) continue;
      const agent = s.target ? agentForTarget(s.target) : null;
      if (agent) for (const m of s.members) members[agent].add(m.id);
    }
    const items: LabRuneItem[] = [];
    for (const rune of l.runes) {
      for (const id of AGENT_IDS) {
        if (enabled.has(id) && members[id].has(rune.id)) items.push({ rune, target: AGENTS[id].instructionsFile });
      }
    }
    return { lib: l.key, items };
  });
}

/** A history row belongs to an item when its target (absent on Claude rows) equals the item's. */
export function rowMatches(row: { target?: string | null }, target: LabTarget): boolean {
  return (row.target ?? "CLAUDE.md") === target;
}

/** A Codex item refuses cases that declare tools (tools/lab/codex.mjs): mark them so no command is offered. */
export function casesFor<C extends { toolsDeclared?: boolean; error?: string }>(cases: C[], target: LabTarget): C[] {
  if (target !== "AGENTS.md") return cases;
  return cases.map((c) => (c.toolsDeclared && !c.error ? { ...c, error: CODEX_TOOLS_ERROR } : c));
}
