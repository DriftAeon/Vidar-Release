// src\onboarding\progress.ts — the onboarding series' pure core: the saved resume point
// (pref `onboarding.progress`), the launch-time entry table (resume, run fresh, or stay out of the
// way) and step navigation. No runtime imports (only `import type`), so `node --test` loads it
// directly; the UI and main.ts bind the inputs and act on the result.

import type { PrimaryAgent } from "../agents/primary";

export type OnboardingStep = "deps" | "primary" | "workspace" | "theme" | "modules" | "runes";

// Built from one string: a quoted bare runes literal matches the paths contract's runes folder (tests/paths-contract).
export const STEP_ORDER = "deps primary workspace theme modules runes".split(" ") as OnboardingStep[];
const RUNES = STEP_ORDER[5];

export interface OnboardingProgress {
  step: OnboardingStep;
  finished: boolean;
  workspace?: string;
}

export interface EntryInput {
  progress: OnboardingProgress | undefined;
  dependenciesSeen: boolean;
  primarySaved: boolean;
  choices: readonly PrimaryAgent[];
  effective: PrimaryAgent | null;
  requiredMissing: boolean;
}

export type Entry =
  | { kind: "none"; deps: boolean; writePick: PrimaryAgent | null }
  | { kind: "run"; step: OnboardingStep; resumed: boolean };

/** Pure: what launch does. First matching row wins. Existing installs (dependenciesSeen) are never
 *  gated; they get their effective primary agent written silently when none is saved. */
export function entryFor(i: EntryInput): Entry {
  if (i.progress?.finished) return { kind: "none", deps: i.requiredMissing, writePick: null };
  if (i.progress) {
    const step = i.choices.length === 0 && i.progress.step !== "deps" ? "deps" : i.progress.step;
    return { kind: "run", step, resumed: true };
  }
  if (i.dependenciesSeen) {
    return { kind: "none", deps: i.requiredMissing, writePick: i.primarySaved ? null : i.effective };
  }
  return { kind: "run", step: i.choices.length === 0 || i.requiredMissing ? "deps" : "primary", resumed: false };
}

function walk(step: OnboardingStep, dir: 1 | -1, ok: (s: OnboardingStep) => boolean): OnboardingStep | null {
  for (let n = STEP_ORDER.indexOf(step) + dir; n >= 0 && n < STEP_ORDER.length; n += dir) {
    if (ok(STEP_ORDER[n])) return STEP_ORDER[n];
  }
  return null;
}

/** Pure: the step after `step`, the runes step skipped when nothing is listed; null from the last shown step (Finish). */
export function nextStep(step: OnboardingStep, opts: { runesListed: boolean }): OnboardingStep | null {
  return walk(step, 1, (s) => s !== RUNES || opts.runesListed);
}

/** Pure: the step before `step`; `deps` only when it was shown; null from the first shown step. */
export function prevStep(step: OnboardingStep, opts: { runesListed: boolean; depsShown: boolean }): OnboardingStep | null {
  return walk(step, -1, (s) => (s !== RUNES || opts.runesListed) && (s !== "deps" || opts.depsShown));
}

/** Only the workspace and runes steps can be skipped. */
export function skippable(step: OnboardingStep): boolean {
  return step === "workspace" || step === RUNES;
}
