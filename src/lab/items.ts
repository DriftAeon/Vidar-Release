// Which runes the Lab lists, and which history rows belong to which agent. Pure (no DOM) so a test
// can import it; `isOn` is the module registry's `moduleOn`, injected.
import type { RuneItem, RuneLibraryKey, RuneSet } from "../runes/types";

export type LabTarget = "CLAUDE.md" | "AGENTS.md";

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

const CLAUDE_TARGET = /(^|[\\/])CLAUDE\.md$/i;
const AGENTS_TARGET = /(^|[\\/])AGENTS\.md$/i;

/** Runes that are members of a set targeting CLAUDE.md (agent `claude` on) or AGENTS.md (agent `codex` on),
 *  per library in catalog order; a rune in both gives a Claude item then a Codex item. Other targets
 *  (`.claude/rules/*`, plugins) are not Lab items. */
export function labItems(libs: LabLibraryLike[], isOn: (id: string) => boolean): LabGroup[] {
  const claude = isOn("claude");
  const codex = isOn("codex");
  return libs.map((l) => {
    const inClaude = new Set<string>();
    const inCodex = new Set<string>();
    for (const s of l.sets) {
      const t = s.target;
      if (!t) continue;
      const into = CLAUDE_TARGET.test(t) ? inClaude : AGENTS_TARGET.test(t) ? inCodex : null;
      if (into) for (const m of s.members) into.add(m.id);
    }
    const items: LabRuneItem[] = [];
    for (const rune of l.runes) {
      if (claude && inClaude.has(rune.id)) items.push({ rune, target: "CLAUDE.md" });
      if (codex && inCodex.has(rune.id)) items.push({ rune, target: "AGENTS.md" });
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
