// src\onboarding\start.ts — what launch does about onboarding: decide from the entry table
// (progress.ts, after detection settles), then run the overlay, stay out of the way, or fall back to
// today's Dependencies tab. Importing the step files registers them with the shell.
import { effectivePrimary, primaryAsked, primaryChoices } from "../agents/primary";
import { loadDeps } from "../deps/state";
import { invoke } from "../ipc";
import { moduleListed } from "../modules/registry";
import { revealWorkbenchTab } from "../panels/workbench";
import { getPref } from "../prefs";
import { maybeShowDependenciesAtLaunch, requiredMissing } from "../settings/dependencies";
import { entryFor, type OnboardingStep } from "./progress";
import { openOnboarding } from "./shell";
import "./step-deps";
import "./step-primary";
import "./step-workspace";
import "./step-theme";
import "./step-modules";
import "./step-runes";
import { runeRunGoing } from "./step-runes";

/** The release lists the Runes workbench module (a set may list none). */
function runesListed(): boolean {
  return moduleListed("runelib");
}

/** Runs the overlay from `step`; Finish with a first-runeset run going opens the Runes tab. */
export function runOnboarding(step: OnboardingStep, depsShown: boolean): void {
  openOnboarding(step, {
    runesListed,
    depsShown,
    onClose: () => {
      if (runeRunGoing()) revealWorkbenchTab("runelib");
    },
  });
}

export async function startOnboarding(): Promise<void> {
  await loadDeps(); // never rejects; modules fail open until detection lands
  const entry = entryFor({
    progress: getPref("onboarding.progress"),
    dependenciesSeen: getPref("onboarding.dependenciesSeen") === true,
    primarySaved: primaryAsked(),
    choices: primaryChoices(),
    effective: effectivePrimary(),
    requiredMissing: requiredMissing(),
  });
  if (entry.kind === "run") {
    runOnboarding(entry.step, entry.step === "deps");
    return;
  }
  if (entry.writePick) {
    await invoke("patch_settings", { key: "primaryAgent", value: entry.writePick }).catch((e: unknown) => {
      console.error(`primaryAgent not saved: ${String(e)}`);
    });
  }
  if (entry.deps) await maybeShowDependenciesAtLaunch();
}
