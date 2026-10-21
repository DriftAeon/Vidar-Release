// src\deps\setup-agent.ts — "Setup Via Agent": why the button is blocked, and the launch.
// createSession is imported dynamically so tests and the settings bundle never load xterm eagerly.

import type { SessionAgent } from "../panels/sessions/types";
import { modulesOf } from "../modules/registry";
import { depsError, depsReport, isDetecting, missingEntries, missingRequired, shownDeps } from "./state";
import { buildSetupPrompt, missingSetupAgentMessage, pickSetupRunner, setupCommand } from "./setup-prompt";
import { effectivePrimary } from "../agents/primary";
import { asideForTab } from "../onboarding/aside";

/** The first active agent with a found setup dependency, primary first, or null. */
function setupRunner(): { id: string; exe: string } | null {
  return pickSetupRunner(modulesOf("agent"), depsReport(), effectivePrimary());
}

/** Why "Setup Via Agent" cannot run right now, or null when it can. */
export function setupAgentBlocker(): string | null {
  if (isDetecting()) return "Checking…";
  const report = depsReport();
  if (report === null) return depsError() === null ? "Checking…" : "Detection Failed";
  const agents = modulesOf("agent");
  const primary = effectivePrimary();
  // shownDeps: a release build's dead vidar deps never reach the message (deps/state.ts).
  if (pickSetupRunner(agents, report, primary) === null) return missingSetupAgentMessage(agents, shownDeps(), primary);
  // Required misses only (catalog `required`): an optional agent the user never installed, or any
  // other optional row, is not something Setup has to do. The page hides Setup in that case too.
  if (missingRequired().length === 0) return "Nothing Required Missing";
  return null;
}

/** Opens a foreground tab of the chosen agent primed with the setup prompt; returns its tab id. */
export async function startSetupAgent(): Promise<string> {
  const report = depsReport();
  const runner = setupRunner();
  if (report === null || runner === null) throw new Error(setupAgentBlocker() ?? "No Setup Agent Found");
  const { createSession } = await import("../panels/sessions");
  const id = await createSession({
    agent: runner.id as SessionAgent, // a setup runner is a core agent module: claude or codex
    cwd: report.root,
    title: "Setup · Dependencies",
    args: ["-NoExit", "-Command", setupCommand(buildSetupPrompt(missingEntries()), runner.exe)],
  });
  asideForTab(id); // onboarding overlay up: it steps aside until this tab is removed
  return id;
}
