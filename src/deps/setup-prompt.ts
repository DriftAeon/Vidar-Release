// src\deps\setup-prompt.ts — the one-line prompt and pwsh command for "Set up with an agent".
// Pure and Node-loadable: type-only imports, so tests can import this file directly.

import type { DepEntry } from "./types";

/** Newlines in catalog text would break the single-line prompt; fold them to one space. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** The install route shown to Claude: winget first, then command, then url, then note. */
function installRoute(entry: DepEntry): string {
  const i = entry.install;
  if (i.winget) return `run \`winget install --id ${i.winget} -e\``;
  if (i.command) return `run \`${i.command}\``;
  if (i.url) return `get it from ${i.url}`;
  if (i.note) return i.note;
  return "no install route in the catalog";
}

export function buildSetupPrompt(missing: DepEntry[]): string {
  const ordered = [...missing.filter((d) => d.required), ...missing.filter((d) => !d.required)];
  const items = ordered
    .map((d, n) => `(${n + 1}) ${d.label} [${d.required ? "required" : "optional"}]: ${installRoute(d)}.`)
    .join(" ");
  const text =
    `Vidar's Dependencies page found these missing: ${items} ` +
    "Install them one at a time, required ones first, and confirm with me before each install. " +
    "After each one, verify it (Get-Command for a program, or check that the file exists). " +
    "Never edit vidar.json and never set secrets or keys for me (the Rider path, an API key): " +
    "tell me exactly what to set and where instead. " +
    "When you are done, tell me to press Recheck on the Dependencies tab.";
  // codex is found as codex.cmd, so the prompt crosses a cmd.exe hop where `"` and `%` are not
  // inert even inside pwsh single quotes. Catalog text never holds them (the Rust validator
  // rejects them); this keeps it true if one slips through.
  return oneLine(text).replace(/["%]/g, "");
}

type SetupModule = {
  id: string;
  kind: string;
  label: string;
  deps?: readonly { id: string; label: string }[];
  agent?: { setup?: { dep: string; order?: number } };
};

/** Active setup agents: the primary agent (`src/agents/primary.ts` `effectivePrimary`, passed in by
 *  the caller) first, then ascending setup order; ties keep registry order. */
function orderedSetupAgents(modules: readonly SetupModule[], primary?: string | null): SetupModule[] {
  const rank = (m: SetupModule): number =>
    primary && m.id === primary ? Number.NEGATIVE_INFINITY : m.agent?.setup?.order ?? Number.POSITIVE_INFINITY;
  return modules
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.kind === "agent" && m.agent?.setup?.dep !== undefined)
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => m);
}

/** The blocker when no active setup agent can run. Names come from dependency display labels. */
export function missingSetupAgentMessage(
  modules: readonly SetupModule[],
  catalog: readonly { id: string; label: string }[],
  primary?: string | null,
): string {
  const names = orderedSetupAgents(modules, primary).map((m) => {
    const dep = m.agent!.setup!.dep;
    return catalog.find((d) => d.id === dep)?.label ?? m.deps?.find((d) => d.id === dep)?.label ?? m.label;
  });
  return names.length === 0
    ? "No Agent Module Enabled"
    : `No Setup Agent Found: Install ${names.join(" Or ")}, Then Recheck`;
}

/** The agent a setup tab runs in: the first active agent module, primary first, then by ascending
 *  `agent.setup.order` (absent sorts last, ties keep registry order), whose `setup.dep` row is
 *  found with a location. Null when none. `modules` is the active module list, in registry order. */
export function pickSetupRunner(
  modules: readonly SetupModule[],
  report: { deps: readonly { id: string; found: boolean; location?: string }[] } | null,
  primary?: string | null,
): { id: string; exe: string } | null {
  if (!report) return null;
  for (const m of orderedSetupAgents(modules, primary)) {
    const dep = m.agent!.setup!.dep;
    const row = report.deps.find((d) => d.id === dep);
    if (row?.found && row.location) return { id: m.id, exe: row.location };
  }
  return null;
}

/** A pwsh single-quoted literal: $, backtick and " stay literal. pwsh also closes a single-quoted
 *  string on the curly quotes U+2018-U+201B, so each of those is doubled like ASCII '. */
function pwshQuote(text: string): string {
  return `'${text.replace(/['‘-‛]/g, "$&$&")}'`;
}

// Route: pwsh -NoExit -Command "& '<exe>' '<prompt>'" — the exe is the detected `claude` location
// (a shim path counts), called through & so a quoted path runs. Newlines in the prompt are
// collapsed first so the argument stays on one line.
export function setupCommand(prompt: string, exe: string): string {
  return `& ${pwshQuote(exe)} ${pwshQuote(oneLine(prompt))}`;
}
