// Rule injection, the IPC half: one `rules_prepare` call per fresh launch of an agent row that
// carries `rules`. The result rides the new session (LaunchOpts.rules) and is reused by Resume,
// Retry and body switches, so a library edit reaches new tabs only. Refusals and a failed call
// come back as a warning with no file: the tab launches without rules and says why.
import { invoke } from "../ipc";
import type { AgentType } from "../config";
import { rulesPlan, type RulesLaunch } from "./inject";

/** `undefined` = the row has no `rules`, or carries a launch profile; nothing to carry. */
export async function prepareRules(row: AgentType): Promise<RulesLaunch | undefined> {
  // A profiled row (bare) ignores `rules` (bare-mode Design 9): its layer comes from the profile.
  if (row.profile) return undefined;
  try {
    const plan = rulesPlan(row);
    if (!plan) return undefined;
    if ("warning" in plan) return { file: null, codex: null, warnings: [plan.warning] };
    const r = await invoke("rules_prepare", { key: plan.key, ids: plan.ids, client: plan.client });
    return { file: r.file, codex: r.codex, warnings: r.warnings };
  } catch (e) {
    return { file: null, codex: null, warnings: [`Rules not applied: Vidar could not run the rules build (${String(e)}). Open a new tab to retry.`] };
  }
}
