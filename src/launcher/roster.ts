// Launcher roster: the built-in agent and location lists, the resolved type/variant state, and the
// spawn paths (spawnFrom, spawnAstra) every launcher surface opens a tab through (split from main.ts).
import { createSession, hasArmedAstra } from "../panels/sessions";
import { recordedVault } from "../panels/sessions/lookup";
import type { ModuleRow } from "../modules/registry";
import { moduleViews } from "../modules/registry";
import { agentKind, gatewayAgent } from "./agent-kind";
import { rawPackRows } from "./pack-rows";
export { agentKind } from "./agent-kind";
import type { AgentType, Location } from "../config";
import { invoke, type SetRef } from "../ipc";
import { depFound, isAvailable } from "../deps/state";
import { setPrimaryRootSource, shownIdsKey, shownRootsOf, shownVariantsOf } from "./roster-shown";
import { resolveVidarCwd } from "./vidar-path";
import { prepareRules } from "../rules/prepare";
import { geminiHiddenArgs } from "../startup-updates/gemini-launch";
import { effectivePrimary } from "../agents/primary";
import { AGENT_IDS, PTY_ONLY_IDS, isAgentId, type AgentId } from "../agents/id";
import { ALL_ROWS } from "./row-facts";

const astraAgent: Record<AgentId, boolean> = { claude: false, codex: true };
const astraDependency: AgentId = AGENT_IDS.find((id) => astraAgent[id])!;
const ptyArgHandlers: Record<typeof PTY_ONLY_IDS[number], (args: string[] | undefined, shell?: string) => string[] | undefined> = {
  [PTY_ONLY_IDS[0]]: geminiHiddenArgs,
  [PTY_ONLY_IDS[1]]: (args) => args,
};
function ptyArgs(id: string, args: string[] | undefined, shell?: string): string[] | undefined {
  return (PTY_ONLY_IDS as readonly string[]).includes(id)
    ? ptyArgHandlers[id as typeof PTY_ONLY_IDS[number]](args, shell) : args;
}

// The primary agent's root leads Claude/Codex in the default order, read at every shaping.
setPrimaryRootSource(effectivePrimary);

// closeLauncher belongs to the launcher menu; spawnFrom reaches it through this setter so the
// roster never imports its caller.
let closeLauncher: () => void = () => {};
export function setCloseLauncher(fn: () => void): void {
  closeLauncher = fn;
}

// Every row has a unique `key`: a vidar.json entry naming it overrides that
// row whatever its label/under says; key-less entries still match by id/under/label
// (config-agents.ts). Keys are stable identifiers — rename a label, never a key.
export const BUILTIN_AGENTS: AgentType[] = [
  // `requires`: catalog ids in contracts\dependencies.json; a missing one hides the row
  // (launcher\roster-shown.ts). Shells carry none: pwsh is every tab's host, not a row's choice.
  // The Bare roots lead Claude and Codex: Raw on Vidar's own home and layer (profiles/bare/*.json).
  // The backend builds the spawn line from the profile, so a Bare row carries no shell, args or rules.
  // The plain rows (PLAIN_KEYS, below) are an escape hatch, off until Settings › Agents turns them on.
  // Per agent (launcher/row-facts.ts, one table row each): the Bare root, then its Rendered variant.
  // Claude Rendered is Falcon-hosted on the same home and layer (profiles/bare/claude.json `rendered`):
  // Vidar prepares the home, Falcon builds the env, the sidecar maps the profile. Our Fable
  // guard (an unset model must never resolve to Fable on the host) lives in our vidar.json overlay;
  // config-agents.ts migrates a retired `claude-rendered` entry (model, effort, cwd) onto this row.
  // The Codex TUI runs in a PTY on the same home, config.toml and layer as Rendered (profiles/bare/codex.json
  // `rawArgs`; the backend spawns `node codex.js` itself); Codex Rendered is the app-server on Vidar's own
  // home and layer, where the backend resolves the binary and builds env, home and config.toml.
  ...ALL_ROWS.flatMap((r) => [r.bare, r.bareRendered]),
  // Reviewer tab, a Codex variant (sits in Codex's flyout): approvals off so
  // nothing typed into it can approve a command (a review is read-only; a
  // blocked command just fails back to the model). `{vidar}` is the Vidar folder (vidar-path.ts, K6).
  // `desks` is the opt-in pack in tools\desks\ (K2): without its built hook wrapper done.json never
  // lands, so the row stays hidden until setup step 1 ran (tools\desks\README.md).
  ...AGENT_IDS.filter((id) => astraAgent[id]).map((id): AgentType => ({ key: "astra", id, label: "Astra", under: id, role: "astra", requires: [id, "desks"], cwd: "{vidar}\\runtime\\bridge\\display", args: ["-NoExit", "-Command", "codex -a never -s workspace-write -m gpt-6-astra -c model_reasoning_effort=low -c model_verbosity=low"] })),
  // The plain (non-Bare) rows, in PLAIN_KEYS: Claude and Codex as the CLI starts them, hidden from
  // builtinAgents() unless the "launcher.plainRows" pref is on. A plain Rendered variant hangs off the
  // plain root (resolveAgents), not the Bare one.
  ...ALL_ROWS.flatMap((r) => [r.plain, r.plainRendered]),
  // Pack rows come from builtinAgents() below, including Gemini, Pi, Local and gateways.
  // the plain shell sits last: it's the fallback, not the common case
  { key: "terminal", id: "shell", label: "Terminal" },
];

/** The retired built-in rows that stay as an escape hatch: shown only while plain rows are on. */
export const PLAIN_KEYS: ReadonlySet<string> = new Set(ALL_ROWS.flatMap((r) => [r.plain.key!, r.plainRendered.key!]));

// Whether the plain rows are shown; settings/agents.ts binds the "launcher.plainRows" pref. Off until bound.
let plainRowsOn: () => boolean = () => false;
export function setPlainRowsSource(fn: () => boolean): void {
  plainRowsOn = fn;
}

// Core rows plus one root and one Rendered variant per present gateway module (pack agent.gateway),
// from one template. `requires` hides a row whose key dep is missing, so a machine without the key
// never shows it. Raw uses vendor-tab.ps1; Rendered uses vendor-prepare.ps1, which builds and checks
// the fence and strips other credentials first. Gateway policy lives in those helpers.
// The present gateway modules, injected by main.ts from launcher/gateways.ts so the roster never
// imports the module registry (and its IPC) itself.
let gatewayModules: () => ModuleRow[] = () => [];
export function setGatewayModules(fn: () => ModuleRow[]): void {
  gatewayModules = fn;
}

function gatewayRows(): AgentType[] {
  return gatewayModules().flatMap((m) => {
    const deps = m.when?.deps ?? [];
    const want = m.agent?.rows ?? ["raw", "rendered"];
    const rows: AgentType[] = [];
    if (want.includes("raw")) {
      rows.push({ key: m.id, id: m.id, label: m.label, model: m.agent?.gateway?.model, requires: [gatewayAgent, ...deps], args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", `if (-not $env:VIDAR_ROOT) { throw 'VIDAR_ROOT is not set: this Vidar build predates vendor tabs' }; & \"$env:VIDAR_ROOT/tools/vendor/vendor-tab.ps1\" -Vendor ${m.id}`] });
    }
    if (want.includes("rendered")) {
      rows.push({ key: `${m.id}-rendered`, id: m.id, label: "Rendered", under: m.id, body: "rendered", permissionMode: "auto", requires: [gatewayAgent, "node", "falcon", ...deps] });
    }
    return rows;
  });
}

/** Core rows plus present pack rows, ahead of the plain shell. Read at use, never cached. */
export function builtinAgents(): AgentType[] {
  const packs = rawPackRows(moduleViews().filter((v) => !v.reason).map((v) => v.row));
  const gateways = gatewayRows();
  const core = plainRowsOn() ? BUILTIN_AGENTS : BUILTIN_AGENTS.filter((a) => !a.key || !PLAIN_KEYS.has(a.key));
  const at = core.findIndex((a) => a.key === "terminal");
  if (at < 0) return [...core, ...packs, ...gateways];
  return [...core.slice(0, at), ...packs, ...gateways, ...core.slice(at)];
}

export function typeLabel(t: AgentType): string {
  return t.label ?? t.id;
}

// `title` overrides the themed default name (tab-names.ts) — a variant launched from
// its flyout row has no location step, so it's titled by its label alone.
// A `{vidar}` cwd resolves first (vidar-path.ts) and rejects "Vidar Folder Unknown" without one.
// `draft` (rendered rows) preloads the composer unsent; `onAdopted` fires once the first spawn settles.
// The last vault a Bare launch used, per agent: the launcher's pre-pick (Q2) and a plain row click.
// Kept in runtime/vaults/defaults.json (rune_vault_defaults), read once at load so a relaunch pre-picks
// the last vault; a launch before that read lands keeps its own pick.
const lastVault = new Map<string, string>();
if (typeof window !== "undefined") {
  void invoke("rune_vault_defaults").then((saved) => {
    for (const [agent, vault] of Object.entries(saved)) if (!lastVault.has(agent)) lastVault.set(agent, vault);
  }).catch(() => undefined);
}

/** The vault a plain Bare row click launches on: the last one used for this agent, else its stock vault. */
export function defaultVault(agent: string): string {
  return lastVault.get(agent) ?? `stock-${agent}`;
}

/** Records the vault a Bare launch used, so the next pick and plain click pre-pick it, after a relaunch too. */
export function rememberVault(agent: string, vault: string): void {
  if (lastVault.get(agent) === vault) return;
  lastVault.set(agent, vault);
  void invoke("rune_vault_default_set", { agent, vault }).catch(() => undefined);
}

// `pick` is the set-list transition (a resumed thread's manifest sets, a reopened workspace's saved
// sets): Rust makes a Custom vault from it. `vault` names the Rune Vault to load and wins over `pick`;
// a Bare row with neither loads its recorded vault on resume, else defaultVault. A row's own `sets`
// and a workspace's add-ons are never read (model R2: a session loads exactly one vault).
export async function spawnFrom(t: AgentType, loc: Location, title?: string, resume?: string, draft?: string, onAdopted?: (ok: boolean, reason?: string) => void, pick?: SetRef[], vault?: string): Promise<string> {
  closeLauncher();
  // A launch profile belongs to a Claude or Codex row without a role (Raw in a PTY, Rendered on
  // Falcon or in-process) only: on a gateway row, another agent, the shell or a role it would open
  // a bare tab under that row's name.
  const bareAgent = isAgentId(t.id) && !t.role;
  if (t.profile && !bareAgent) {
    throw new Error(`${typeLabel(t)} cannot carry the ${t.profile} profile: profiles are for Claude and Codex rows without a role only`);
  }
  // A vault or a set list rides only a Bare spawn: any other launch would drop it quietly.
  if ((vault || pick?.length) && !t.profile) {
    throw new Error("A Rune Vault loads only on a Bare row; this row would launch without it.");
  }
  const kind = agentKind(t.id);
  const bareVault = !t.profile ? undefined
    : vault ?? (pick !== undefined ? undefined : (resume ? await recordedVault("", null, resume) : null) ?? defaultVault(kind));
  if (bareVault) rememberVault(kind, bareVault);
  const cwd = await resolveVidarCwd(t.cwd ?? loc.cwd);
  // once per fresh launch; the tab keeps it for Resume, Retry and body switches. A profiled row
  // ignores `rules` and sends no shell or args: the backend owns its spawn line (Design 9).
  const rules = await prepareRules(t);
  return createSession({
    rules,
    profile: t.profile,
    rowKey: t.profile && t.key ? t.key : undefined,
    ...(bareVault ? { vault: bareVault } : t.profile && pick !== undefined ? { sets: pick } : {}),
    agent: kind,
    art: t.id,
    shell: t.profile ? undefined : t.shell,
    cwd,
    args: t.profile ? undefined : ptyArgs(t.id, t.args, t.shell),
    model: t.model,
    effort: t.effort,
    role: t.role,
    body: t.body === "rendered" ? "rendered" : undefined,
    // A Bare row's mode comes from its vault's mode rune (D-c, Rust); the row's own is not read.
    permissionMode: t.profile ? undefined : t.permissionMode,
    resume, // rendered only: a past session to continue (Rust refuses one that is live)
    draft,
    onAdopted,
    // `dataset.agent` drives the tab border colour; the title is what the
    // tooltip and inspect label show. Unset: createSession mints a themed name.
    title,
  });
}

// The Astra variant from the resolved launcher list, opened in the background
// with focus handed back to the asker. Rejects rather than returning silently:
// the ask gate has to tell the user WHY nothing opened, and "already armed" and
// "no launcher entry" are different problems.
export async function spawnAstra(returnTo: string): Promise<string> {
  // The gate is the dep check: desks and codex must be confirmed found (depFound is null before the dep
  // report, where isAvailable is true), else the pick below falls through to a user role-astra row
  // (Astra Code, workspace-write at the repo root) instead of the read-only bridge\display tab.
  if (depFound("desks") !== true || depFound(astraDependency) !== true) return Promise.reject(new Error("Desks Pack Not Set Up"));
  // only what the launcher shows: a hidden Codex (dependency missing) takes Astra with it
  const roots = shownRoots();
  const astra = roots.flatMap(shownVariants).find((v) => v.role === "astra")
    ?? roots.find((x) => x.role === "astra");
  if (!astra) return Promise.reject(new Error("no Astra entry in the launcher list"));
  if (hasArmedAstra()) return Promise.reject(new Error("an Astra tab is already armed — one at a time, the Codex meter is per account"));
  const cwd = await resolveVidarCwd(astra.cwd); // rejects "Vidar Folder Unknown"; the ask gate shows it
  const rules = await prepareRules(astra);
  return createSession({
    rules,
    agent: agentKind(astra.id),
    art: astra.id,
    shell: astra.shell,
    cwd, // unset: createSession falls back to the backend's default folder
    args: astra.args,
    model: astra.model,
    role: "astra",
    title: typeLabel(astra),
    background: true,
    returnTo,
  });
}

// Variants per top-level type, set by setRoster (buildTypeMenu calls it) and read by every
// flyout rebuild (openLocations is also the Back target of Active/Add new…).
// Read-only outside this file: only setRoster writes either binding.
export let variantsOf = new Map<AgentType, AgentType[]>();
// what setRoster last resolved: a rendered body typing "/resume" knows only
// its kind and cwd, and the AgentType pair is resolved from here. Reassigned on every
// setRoster, so a holder from before the config lands reads it through rosterView().
export let launcherTypes: AgentType[] = [];

// The one writer of variantsOf/launcherTypes: resolve the configured agents list into
// top-level rows and their variants.
export function setRoster(agents: AgentType[]): void {
  const resolved = resolveAgents(agents);
  variantsOf = resolved.variantsOf;
  launcherTypes = resolved.top;
}

// Live read of both bindings for holders that outlive a setRoster (initDrive).
export function rosterView(): { variantsOf: Map<AgentType, AgentType[]>; launcherTypes: AgentType[] } {
  return { variantsOf, launcherTypes };
}

// Dependency gating: variantsOf and launcherTypes stay the unfiltered source; the menu,
// the location flyout, the "/resume" answer (recent.ts) and spawnAstra read through these, so the
// view follows the latest report without a re-resolve. drive.ts still reads the source.
// A hidden root's variants are empty here, so a hidden root never promotes a child
// (pure rule in roster-shown.ts).
export function shownRoots(): AgentType[] {
  return shownRootsOf(launcherTypes, isAvailable);
}
export function shownVariants(root: AgentType): AgentType[] {
  return shownVariantsOf(root, launcherTypes, variantsOf, isAvailable);
}
// What the launcher shows right now, comparable across reports (menu.ts redraws on a change).
export function shownKey(): string {
  return shownIdsKey(launcherTypes, variantsOf, isAvailable);
}

// Split the agents list into top-level rows and the variants hanging off them.
// A variant attaches to the FIRST root sharing its `under` id (two roots with
// one id don't both host it); roots never chain. Orphans (no root with that
// id) and cwd-less variants are config mistakes — the former is promoted to a
// top-level row so it stays visible, the latter dropped; both warn.
function resolveAgents(agents: AgentType[]): { top: AgentType[]; variantsOf: Map<AgentType, AgentType[]> } {
  const variantsOf = new Map<AgentType, AgentType[]>();
  const roots = agents.filter((a) => !a.under);
  // A plain Rendered variant hangs off the plain root and a Bare one off the Bare root when both are
  // shown; any other variant (Astra, a custom folder variant) and one without a same-kind root take
  // the first root.
  const hostFor = (a: AgentType) => {
    const same = a.body !== "rendered" || a.role ? undefined : roots.find((r) => r.id === a.under && !r.profile === !a.profile);
    return same ?? roots.find((r) => r.id === a.under);
  };
  const top: AgentType[] = [];
  for (const a of agents) {
    if (!a.under) {
      top.push(a);
      continue;
    }
    const host = hostFor(a);
    if (!host) {
      console.warn(`vidar.json agents: "${typeLabel(a)}" is under "${a.under}" but no top-level type has that id — showing it at top level`);
      top.push(a);
      continue;
    }
    // a rendered or profiled (bare) variant is a BODY choice offered after the location step,
    // so it needs no cwd of its own; any it carries is ignored
    if (!a.cwd?.trim() && a.body !== "rendered" && !a.profile) {
      console.warn(`vidar.json agents: variant "${typeLabel(a)}" has no cwd — dropped (a variant has no location step)`);
      continue;
    }
    variantsOf.set(host, [...(variantsOf.get(host) ?? []), a]);
  }
  return { top, variantsOf };
}
