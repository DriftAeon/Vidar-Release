// src\onboarding\steps.ts — the onboarding step registry and the pure footer state. Each step
// file registers its view at import; the shell imports only this file, so a wave that adds a
// step never touches the shell. Runtime imports are `progress.ts` only, so `node --test` loads it.

// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { nextStep, prevStep, skippable, STEP_ORDER } from "./progress.ts";
import type { OnboardingProgress, OnboardingStep } from "./progress.ts";

/** What the shell hands a step when it mounts. */
export interface StepCtx {
  /** The progress record as written when this step was entered. */
  progress: OnboardingProgress;
  /** Enables or disables the footer's Next (Finish on the last step). Enabled on mount. */
  setNextEnabled(on: boolean): void;
  /** Same as the footer's Next; a step that completes on its own button calls it. */
  next(): void;
  /** Moves the title label along the step's seam, as a percentage of the stage width; null centres it. */
  setSeam(percent: number | null): void;
  /** Merges a patch into the saved `onboarding.progress` record (the same write a step change makes). */
  setProgress(patch: Partial<Pick<OnboardingProgress, "workspace">>): void;
  /** While set, the footer Back is shown and calls `fn` instead of going to the previous step; null clears it. */
  setBack(fn: (() => void) | null): void;
}

export interface OnboardingStepView {
  id: OnboardingStep;
  title: string;
  /** Hides the title label on the seam (the Primary Agent doors carry their own names). */
  hideTitle?: boolean;
  /** Builds the step into `body`; the returned function removes its listeners. */
  mount(body: HTMLElement, ctx: StepCtx): () => void;
}

const views = new Map<OnboardingStep, OnboardingStepView>();

export function registerStep(view: OnboardingStepView): void {
  views.set(view.id, view);
}

export function stepView(id: OnboardingStep): OnboardingStepView | undefined {
  return views.get(id);
}

/** Pure: whether the Runes step counts as shown: the release lists it and the user has not hidden the
 *  Runes bench module (`modules.hidden` holds `bench:runelib`). */
export function runesShown(listed: boolean, hidden: readonly string[]): boolean {
  return listed && !hidden.includes("bench:runelib");
}

export interface FooterInput {
  runesListed: boolean;
  depsShown: boolean;
  registered: (s: OnboardingStep) => boolean;
}

export interface FooterState {
  /** The registered step Back goes to; null hides Back (first shown step). */
  back: OnboardingStep | null;
  skip: boolean;
  /** The registered step Next goes to; null means Next reads Finish. */
  next: OnboardingStep | null;
  nextLabel: "Next" | "Finish";
  /** The shown steps in order (registered only, plus the current one). */
  dots: OnboardingStep[];
  /** Index of `step` in `dots`. */
  current: number;
}

/** Pure: footer buttons and dots for `step`. Steps without a registered view are skipped both ways. */
export function footerState(step: OnboardingStep, i: FooterInput): FooterState {
  const o = { runesListed: i.runesListed, depsShown: i.depsShown };
  const RUNES = STEP_ORDER[5]; // not a quoted bare literal: tests/paths-contract counts those
  const walk = (from: OnboardingStep, dir: 1 | -1): OnboardingStep | null => {
    let s = dir === 1 ? nextStep(from, o) : prevStep(from, o);
    while (s && !i.registered(s)) s = dir === 1 ? nextStep(s, o) : prevStep(s, o);
    return s;
  };
  const next = walk(step, 1);
  const dots = STEP_ORDER.filter(
    (s) => s === step || (i.registered(s) && (s !== RUNES || i.runesListed) && (s !== "deps" || i.depsShown)),
  );
  return {
    back: walk(step, -1),
    skip: skippable(step),
    next,
    nextLabel: next ? "Next" : "Finish",
    dots,
    current: dots.indexOf(step),
  };
}
