// The copied runner commands. Pure (no DOM) so a test can import it. The constants mirror
// `tools/lab/plan.mjs` DEFAULTS (src cannot import tools/); tests/lab-view.test.mjs pins them.
import type { LabTarget } from "./items";

export type LabLib = "global" | "vidar";

export const REPEATS = 3;
export const ARMS = 2;
export const SESSION_CAP = 12;

/** Sessions a live run plans: cases × repeats × arms, exactly what `--confirm` must equal. */
export const liveSessions = (cases: number): number => cases * REPEATS * ARMS;

/** Codex items name their instruction target; Claude commands carry no flag (the runner's default). */
const targetFlag = (target: LabTarget): string => (target === "AGENTS.md" ? " --target AGENTS.md" : "");

const base = (id: string, lib: LabLib): string => `node tools/lab/run.mjs --item rune:${id} --lib ${lib}`;

export function dryCommand(id: string, lib: LabLib, target: LabTarget = "CLAUDE.md"): string {
  return `${base(id, lib)}${targetFlag(target)}`;
}

/** The live command, or null when the plan is over the runner's session cap (it refuses those). */
export function liveCommand(id: string, lib: LabLib, cases: number, target: LabTarget = "CLAUDE.md"): string | null {
  const n = liveSessions(cases);
  return n > SESSION_CAP ? null : `${base(id, lib)} --live --confirm ${n}${targetFlag(target)}`;
}
