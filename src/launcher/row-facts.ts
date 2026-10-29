// src\launcher\row-facts.ts — the per-agent facts behind the built-in launcher rows, and the four rows
// each full agent gets (Bare root, Bare Rendered, plain root, plain Rendered). Pure: roster.ts spreads
// `ALL_ROWS` into BUILTIN_AGENTS, and `node --test` loads this file directly (runtime imports use `.ts`).
// `Record<AgentId, RowFacts>` makes a third id in AGENT_IDS fail tsc here until its facts exist.
// `requires`: catalog ids in contracts\dependencies.json; a missing one hides the row. Every row first
// requires the agent's own CLI dep (its catalog id is the agent id); the lists below add the rest.
// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { AGENT_IDS } from "../agents/id.ts";
import type { AgentId } from "../agents/id.ts";
// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { AGENTS } from "../agents/descriptor.ts";
import type { AgentType } from "../config";

export interface RowFacts {
  /** Bare root (profiled, Raw in a PTY): deps beyond the agent's own. */
  bareExtra: string[];
  /** Bare Rendered variant: deps beyond the agent's own, and its permission mode (none = the vault's). */
  bareRenderedExtra: string[];
  bareRenderedMode?: AgentType["permissionMode"];
  /** Plain Rendered variant. The plain root requires the agent's own dep only. */
  plainRenderedExtra: string[];
  plainRenderedMode: NonNullable<AgentType["permissionMode"]>;
}

export const ROW_FACTS: Record<AgentId, RowFacts> = {
  claude: {
    bareExtra: [],
    bareRenderedExtra: ["node", "falcon"],
    // auto = Claude Code's classifier mode. No built-in model: the CLI's own default applies.
    bareRenderedMode: "auto",
    plainRenderedExtra: ["node", "falcon"],
    plainRenderedMode: "auto",
  },
  codex: {
    bareExtra: ["node"],
    bareRenderedExtra: ["node"],
    plainRenderedExtra: ["node"],
    plainRenderedMode: "default",
  },
};

export interface AgentRows {
  bare: AgentType;
  bareRendered: AgentType;
  plain: AgentType;
  plainRendered: AgentType;
}

/** The four built-in rows of one agent; keys are `<id>-bare`, `<id>-rendered-bare`, `<id>`, `<id>-rendered`. */
export function rowsFor(id: AgentId): AgentRows {
  const f = ROW_FACTS[id];
  return {
    bare: { key: `${id}-bare`, id, label: AGENTS[id].name, profile: "bare", requires: [id, ...f.bareExtra] },
    bareRendered: {
      key: `${id}-rendered-bare`, id, label: "Rendered", under: id, body: "rendered", profile: "bare",
      ...(f.bareRenderedMode ? { permissionMode: f.bareRenderedMode } : {}),
      requires: [id, ...f.bareRenderedExtra],
    },
    plain: { key: id, id, label: "Plain", requires: [id], args: ["-NoExit", "-Command", id] },
    plainRendered: {
      key: `${id}-rendered`, id, label: "Plain Rendered", under: id, body: "rendered",
      permissionMode: f.plainRenderedMode, requires: [id, ...f.plainRenderedExtra],
    },
  };
}

/** Rows for every full agent, in AGENT_IDS order. */
export const ALL_ROWS: AgentRows[] = AGENT_IDS.map(rowsFor);
