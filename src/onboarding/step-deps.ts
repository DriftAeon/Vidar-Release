// src\onboarding\step-deps.ts — onboarding step 0, Dependencies: the Dependencies page itself
// (mountDependencies) inside the shell. Next waits until an agent can be picked; mounting marks
// the page seen, which keeps the launch-time Dependencies tab from also opening.
import { primaryChoices } from "../agents/primary";
import { onDepsChange } from "../deps/state";
import { onModulesChange } from "../modules/registry";
import { setPref } from "../prefs";
import { mountDependencies } from "../settings/dependencies";
import { registerStep } from "./steps";

registerStep({
  id: "deps",
  title: "Dependencies",
  mount(body, ctx) {
    setPref("onboarding.dependenciesSeen", true);
    const sync = (): void => ctx.setNextEnabled(primaryChoices().length > 0);
    sync();
    // The active-module list follows detection, so it can settle after the report does.
    const offDeps = onDepsChange(sync);
    const offModules = onModulesChange(sync);
    const dispose = mountDependencies(body);
    return () => {
      offDeps();
      offModules();
      dispose();
    };
  },
});
