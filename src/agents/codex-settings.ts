// Session-only Codex selections and the app-server model catalog (0.162.1 schema).
// turn/start uses `model` and `effort`; thread/start/resume accept `model`.
import type { AdapterStart, AgentEvent, Effort } from "./protocol";
import { titleCase } from "../format";

export const CODEX_EFFORT_LEVELS: readonly Effort[] = ["low", "medium", "high", "xhigh"];
type ModelRow = Extract<AgentEvent, { kind: "models" }>["models"][number];

/** Max maps to Extra High; other unsupported picks clamp down to an advertised level. */
export function codexEffort(level: Effort, levels: readonly Effort[]): Effort | undefined {
  const target = level === "max" ? "xhigh" : level;
  const index = CODEX_EFFORT_LEVELS.indexOf(target);
  return CODEX_EFFORT_LEVELS.slice(0, index + 1).filter((l) => levels.includes(l)).at(-1) ?? levels[0];
}

/** The saved `codexModels` copy of a catalog: what a Codex tab saves (events.ts) and what the
 *  tab-less fetch saves (codex-models.ts). */
export function codexModelsPref(models: readonly ModelRow[]): { value: string; label: string; effortLevels: string[] }[] {
  return models.map((m) => ({ value: m.value, label: m.label, effortLevels: [...(m.effortLevels ?? [])] }));
}

export class CodexSettings {
  model?: string;
  effort?: Effort;
  /** the Bare rune payload from the spawn reply; rides every thread/start, never thread/resume */
  developerInstructions?: string;
  private rows: ModelRow[] = [];

  start(opts: AdapterStart) { this.model = opts.model; this.effort = opts.effort; this.developerInstructions = opts.developerInstructions; }
  get turn(): { model?: string; effort?: Effort } {
    const levels = this.rows.find((r) => r.value === this.model)?.effortLevels ?? CODEX_EFFORT_LEVELS;
    return { model: this.model, effort: this.effort ? codexEffort(this.effort, levels) : undefined };
  }
  catalog(data: unknown): ModelRow[] {
    if (Array.isArray(data)) for (const row of data) {
      if (!row || typeof row.model !== "string" || row.hidden) continue;
      const advertised = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : [];
      const effortLevels = CODEX_EFFORT_LEVELS.filter((l) => advertised.some((e: { reasoningEffort?: string }) => e?.reasoningEffort === l));
      this.rows.push({ value: row.model, resolved: row.model, label: titleCase(row.displayName || row.model), effortLevels });
    }
    return [...this.rows];
  }
}
