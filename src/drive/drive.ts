// src\drive\drive.ts — window.__vidarDrive: the DevTools-port automation surface
// (extracted out of main.ts, docs\reference\module-boundaries.md). The only way to call it is Runtime.evaluate
// over the DevTools port, and that port is the opt-in (swap-release.ps1 -Debug) — a
// second gate in here would gate nothing. `window.__vidarDrive.state()` is the async
// `driveStateHosted()` (every hosted tab's Falcon session resolved, for the run ledger);
// the sync `driveSnapshot()` backs `ctl.state` (src\control\registry.ts, listen.ts).

import type { Effort, PermissionMode } from "../agents/protocol";
import { resolveDefaultCwd } from "../config";
import { resolveLaunchVault, type LaunchVaultResult } from "../control/launch-vault";
import { agentKind } from "../launcher/agent-kind";
import {
  driveSnapshot as sessionsDriveSnapshot,
  renderedDrive,
  sessionContainer,
  writeToSession,
} from "../panels/sessions";
import { hostedFalconSession } from "../panels/sessions/lookup";
import { CODEX_EFFORT_LEVELS, codexEffort as normalizeEffort } from "../agents/codex-settings";
import { AGENTS } from "../agents/descriptor";
import { isAgentId } from "../agents/id";
import { gatedHostShape } from "../agents/agent-profile";
import { hostedCodexOn } from "../launcher/readopt";
import { rulesPlan } from "../rules/inject";
import { DRIVE_CLASS as C } from "../panels/rendered-drive";
import { API_KEY_CARD } from "../panels/rendered/api-key-card";
/** One in-flight approval as `state.cards` lists it. */
interface PendingAsk {
  id: string;
  kind: string | null;
  title: string;
  tab: string | null;
  details: Record<string, string>;
  /** always true: the registry shows every record at once */
  onScreen: boolean;
}
import { liveApprovals } from "../asks/approvals";
import { items as relayItems } from "../relay/store";
import { getRegistry } from "../settings/registry";
import { drivePaste, type DrivePastePayload, type DrivePasteResult, type DrivePasteTarget } from "./paste";

type CardDriven = { id: string; kind: string | null; title: string; decision: string };

/** Mirrors main.ts's own `AgentType`/`Location` shapes structurally — no import
 *  back into main.ts, so this stays a leaf module (module-boundaries). */
interface DriveAgentType {
  id: string;
  label?: string;
  shell?: string;
  args?: string[];
  model?: string;
  effort?: Effort;
  role?: "astra";
  cwd?: string;
  under?: string;
  body?: "rendered";
  permissionMode?: PermissionMode;
  /** read by `hostedRenderedAgent`: the hosted-Codex shape (rules file, profile) */
  key?: string;
  rules?: string[];
  profile?: string;
}
interface DriveLocation {
  label: string;
  cwd: string;
}

/** The live inputs `resolveLaunchVault` needs, injected so drive.ts stays free of config and roster imports. */
export interface DriveVaults {
  /** The user's Last Vault for an agent kind (roster `defaultVault`); none yet = undefined */
  last(kind: string): string | undefined;
  /** Ids from `rune_vault_list`; null when it cannot be read */
  listed(): Promise<string[] | null>;
}

export interface DriveDeps {
  spawnFrom(t: DriveAgentType, loc: DriveLocation, title?: string, resume?: string, draft?: string,
    onAdopted?: undefined, pick?: undefined, bare?: { vault?: string; remember?: boolean }): Promise<string>;
  /** Absent in tests that never spawn a Bare row: a Bare spawn then has no Last Vault and is refused. */
  vaults?: DriveVaults;
  /** Read at call time: initDrive runs before the config lands and the roster is
   *  replaced on every setRoster (roster.ts), so a held snapshot would go stale. */
  roster(): { variantsOf: ReadonlyMap<DriveAgentType, readonly DriveAgentType[]>; launcherTypes: readonly DriveAgentType[] };
  /** Read-only view of what the launcher and onboarding show now, for `shown()`; absent in tests that never read it. */
  shown?: DriveShownSource;
}

/** The live reads behind `window.__vidarDrive.shown()`, injected so drive.ts imports neither the roster's
 *  dependency gate nor the onboarding shell. */
export interface DriveShownSource {
  roots(): readonly DriveAgentType[];
  variants(root: DriveAgentType): readonly DriveAgentType[];
  /** True once the first dependency report has landed (`isAvailable` is true before it, so rows alone prove nothing) */
  depsLanded(): boolean;
  onboardingOpen(): boolean;
}

/** What `shown()` returns: launcher row ids as the user sees them. */
export interface DriveShown {
  roots: string[];
  rendered: string[];
  onboarding: boolean;
  depsLanded: boolean;
}

declare global {
  interface Window {
    __vidarDrive?: {
      openTab(opts: { agent: string; model?: string; effort?: Effort; permissionMode?: PermissionMode; cwd?: string; vault?: string }): Promise<string>;
      send(tabId: string, text: string): Promise<boolean>;
      answer(tabId: string, ans: { requestId?: string; option?: string | string[]; decision?: "allow" | "deny"; message?: string }): Promise<{ id: string; tool: string; decision: "allow" | "deny" }>;
      state(): ReturnType<typeof driveStateHosted>;
      shortcut(id: string): { id: string; name: string; activeBefore: string | null; activeAfter: string | null };
      paste(target: DrivePasteTarget, payload: DrivePastePayload): Promise<DrivePasteResult>;
      card(id: string, decision: string, opts?: { choice?: string; comment?: string }): CardDriven | Promise<CardDriven>;
      shown(): DriveShown;
    };
  }
}

let deps: DriveDeps | null = null;

// The rendered variant for a bare agent id ("claude", "codex", …) — same lookup
// spawnAstra already does for role "astra": the resolved flyout first, the raw
// launcher list as fallback (a top-level rendered entry, config mistake or not).
function findRenderedType(agent: string): DriveAgentType | undefined {
  if (!deps) return undefined;
  const { variantsOf, launcherTypes } = deps.roster();
  return [...variantsOf.values()].flat().find((v) => v.under === agent && v.body === "rendered")
    ?? launcherTypes.find((x) => x.id === agent && x.body === "rendered");
}

/** `ctl.spawn`'s pre-Approve check: the same
 *  lookup `driveOpenTab` already refuses on, exposed so the card handler can
 *  refuse before showing the modal instead of after. */
export function hasRenderedAgent(agent: string): boolean {
  return findRenderedType(agent) !== undefined;
}

/** The agent's rendered body runs Falcon-hosted, by the split `attachRenderedBody` makes
 *  (`sessions/rendered-body.ts`): every non-Codex kind always; Codex only when `gatedHostShape`
 *  admits the row (vidar.json `falcon.hostedCodex` on, no rules file, no profile). The host's
 *  `codex_turns` capability is asked only at spawn, so a host without it still lands the tab
 *  in-process and the send refuses (`sendPrompt`: "not a hosted tab"). */
export function hostedRenderedAgent(agent: string): boolean {
  const t = findRenderedType(agent);
  if (t === undefined) return false;
  if (!isAgentId(t.id) || AGENTS[t.id].flowSdk) return true;
  // A profiled row ignores `rules` (rules/prepare.ts); otherwise a valid plan means a rules file.
  const plan = t.profile ? null : rulesPlan(t);
  const rulesFile = plan && !("warning" in plan) ? plan.key : null;
  return gatedHostShape({ hostedCodex: hostedCodexOn(), rulesFile, profile: t.profile ?? null });
}

/** Codex has no "max" (ctl.spawn admits it for every agent): it maps to xhigh before spawn.
 *  Other agents pass through unchanged. */
export function spawnEffort(agentId: string, effort: Effort | undefined): Effort | undefined {
  if (!isAgentId(agentId) || AGENTS[agentId].flowSdk || effort === undefined) return effort;
  return normalizeEffort(effort, CODEX_EFFORT_LEVELS) ?? effort;
}

/** The Rune Vault a `ctl.spawn` of `agent` loads (`control/launch-vault.ts` rules), or a refusal.
 *  Also the card handler's pre-Approve check, so a bad `vault` never reaches the modal. */
export async function LaunchVaultFor(agent: string, asked?: string): Promise<LaunchVaultResult> {
  const rendered = findRenderedType(agent);
  if (!rendered) return { refuse: `no rendered variant for agent "${agent}"` };
  const kind = agentKind(rendered.id);
  const v = deps?.vaults;
  const bare = Boolean(rendered.profile);
  return resolveLaunchVault({
    asked, bare,
    last: v?.last(kind),
    listed: bare && v ? await v.listed() : null,
  });
}

export async function driveOpenTab(opts: { agent: string; model?: string; effort?: Effort; permissionMode?: PermissionMode; cwd?: string; title?: string; vault?: string }): Promise<string> {
  if (!deps) throw new Error("drive not initialized");
  const rendered = findRenderedType(opts.agent);
  if (!rendered) throw new Error(`no rendered variant for agent "${opts.agent}"`);
  const picked = await LaunchVaultFor(opts.agent, opts.vault);
  if ("refuse" in picked) throw new Error(picked.refuse);
  const cwd = opts.cwd ?? rendered.cwd ?? await resolveDefaultCwd();
  if (!cwd) throw new Error("no cwd: pass one, the backend resolved no default folder");
  const effort = spawnEffort(rendered.id, opts.effort ?? rendered.effort);
  return deps.spawnFrom(
    { ...rendered, model: opts.model ?? rendered.model, effort, permissionMode: opts.permissionMode ?? rendered.permissionMode, cwd: undefined },
    { label: "Drive", cwd },
    opts.title, // ctl.spawn --title; undefined: createSession mints a themed name
    undefined, undefined, undefined, undefined,
    // An agent's launch never overwrites the user's Last Vault (remember: false).
    picked.vault !== undefined ? { vault: picked.vault, remember: false } : undefined,
  );
}

export async function driveSend(tabId: string, text: string): Promise<boolean> {
  const tab = driveSnapshot().tabs.find((t) => t.id === tabId);
  if (!tab || tab.body !== "rendered") throw new Error(`tab "${tabId}" is not a rendered body`);
  return writeToSession(tabId, `${text}\r`); // \r is submit — the one contract every write() caller has
}

// Drives the card's own buttons (.q-opt then .approval-allow, or .approval-deny)
// rather than reaching the settle() closure: the buttons are the contract the
// user has, and the disabled-until-answered gate stays tested.
async function driveAnswer(
  tabId: string,
  ans: { requestId?: string; option?: string | string[]; decision?: "allow" | "deny"; message?: string },
): Promise<{ id: string; tool: string; decision: "allow" | "deny" }> {
  const container = sessionContainer(tabId);
  if (!container) throw new Error(`no tab "${tabId}"`);
  // the API key card reuses the Permission card's classes; a driver never answers it
  const cards = [...container.querySelectorAll<HTMLElement>(`.${C.card}:not(.${C.settled}):not(.${API_KEY_CARD})`)];
  let card: HTMLElement | undefined;
  if (ans.requestId !== undefined) {
    card = cards.find((c) => c.dataset.requestId === ans.requestId);
    if (!card) throw new Error(`no pending approval card with request id "${ans.requestId}" in tab "${tabId}"`);
  } else {
    card = cards[0]; // oldest pending — the UI's own default (pendingApproval = approvalQueue[0])
    if (!card) throw new Error(`no pending approval card in tab "${tabId}"`);
  }
  if (ans.option !== undefined) {
    const options = Array.isArray(ans.option) ? ans.option : [ans.option];
    const qs = [...card.querySelectorAll<HTMLElement>(`.${C.question}`)];
    options.forEach((label, i) => {
      const q = qs[i];
      if (!q) throw new Error(`no question ${i} on the pending card`);
      const opt = [...q.querySelectorAll<HTMLButtonElement>(`.${C.option}`)].find((b) => (b.dataset.label ?? b.textContent) === label);
      if (!opt) throw new Error(`no option "${label}" on question ${i}`);
      opt.click();
    });
  }
  const id = card.dataset.requestId ?? "";
  const tool = card.dataset.tool ?? "";
  if (ans.decision === "deny") {
    const msg = card.querySelector<HTMLInputElement>(`.${C.message}`);
    if (msg && ans.message) msg.value = ans.message;
    const deny = card.querySelector<HTMLButtonElement>(`.${C.deny}`);
    if (!deny) throw new Error(`no .${C.deny} on the pending card`);
    deny.click();
    return { id, tool, decision: "deny" };
  }
  const allow = card.querySelector<HTMLButtonElement>(`.${C.allow}`);
  if (!allow) throw new Error(`no .${C.allow} on the pending card`);
  if (allow.disabled) throw new Error("Answer/Allow is disabled — pick an option first");
  allow.click();
  return { id, tool, decision: "allow" };
}

/** Combined snapshot: the session list plus each rendered tab's own chips and
 *  pending cards, and `cards`: the approvals registry's imperative asks (ctl spawn/prompt/
 *  flow, Astra, review dispatch; those live outside any tab). Sync, so `falconSession` is set on
 *  adopted tabs only; backs `ctl.state` (whose projection in control\listen.ts drops
 *  everything but tab names) and `driveStateHosted`. */
export function driveSnapshot() {
  const snap = sessionsDriveSnapshot();
  return {
    activeId: snap.activeId,
    tabs: snap.tabs.map((t) => (t.body === "rendered" ? { ...t, ...renderedDrive(t.id) } : t)),
    cards: registryCards(),
  };
}

const IMPERATIVE_ORIGINS: readonly string[] = ["ctl-prompt", "ctl-spawn", "ctl-flow", "astra", "review-dispatch"];

/** The imperative approvals as `state.cards` entries. ctl-prompt's `tab` is its target tab (the Tab row's
 *  trailing id), as the ask-gate entry carried it; the registry shows every record at once, so onScreen is true. */
function registryCards(): PendingAsk[] {
  // Oldest first, as the ask-gate queue listed them (the registry lists newest first).
  return [...liveApprovals()].reverse().filter((e) => IMPERATIVE_ORIGINS.includes(e.record.origin)).map((e) => {
    const r = e.record;
    const tabRow = r.origin === "ctl-prompt" ? r.rows.find(([k]) => k === "Tab")?.[1] : undefined;
    const cut = tabRow?.lastIndexOf(" · ") ?? -1;
    return {
      id: r.id, kind: r.origin, title: r.title,
      tab: tabRow === undefined ? null : cut >= 0 ? tabRow.slice(cut + 3) : tabRow,
      details: Object.fromEntries(r.rows), onScreen: true,
    };
  });
}

/** `window.__vidarDrive.state()`: `driveSnapshot()` with `falconSession` filled on spawned
 *  hosted tabs from Rust's map, so the run ledger (tools\drive\drive-ledger.mjs) sees them.
 *  Still null for a hosted tab not yet attached; the ledger reports those as unresolved. */
async function driveStateHosted() {
  const snap = driveSnapshot();
  const tabs = await Promise.all(snap.tabs.map(async (t) =>
    t.hosted && !t.falconSession ? { ...t, falconSession: await hostedFalconSession(t.id) } : t));
  return { ...snap, tabs };
}

// Answers an approval card (ctl spawn/prompt/ask/flow, Astra, review dispatch) through
// the same registry entry Relay uses; every listed card is answerable, first answer wins.
function driveCard(id: string, decision: string, opts: { choice?: string; comment?: string } = {}) {
  if (decision !== "approve" && decision !== "deny") throw new Error(`decision must be approve or deny, got "${decision}"`);
  // A ctl.ask is a Relay question item, not a modal; it answers through the item's own resolve.
  const q = relayItems().find((i) => i.id === id && i.view.type === "question" && i.view.record.origin === "ctl-ask");
  if (q && q.view.type === "question") {
    const first = q.view.record.questions[0];
    const reply = { answers: first && opts.choice !== undefined ? { [first.id]: opts.choice } : {}, notes: opts.comment ?? "" };
    return q.resolve({ verdict: decision === "approve" ? "approve" : "deny", comment: opts.comment ?? "", choice: opts.choice, reply })
      .then(() => ({ id, kind: "ctl-ask", title: q.title, decision }));
  }
  // The imperative approvals answer through the registry, the same entry Relay uses: first answer wins.
  const entry = liveApprovals().find((e) => e.record.id === id && IMPERATIVE_ORIGINS.includes(e.record.origin));
  if (entry) {
    return entry.answer({ verdict: decision === "approve" ? "approve" : "deny", comment: opts.comment ?? "", where: "Drive" })
      .then(() => ({ id, kind: entry.record.origin, title: entry.record.title, decision }));
  }
  const pending = registryCards().map((c) => c.id);
  throw new Error(`no pending card "${id}"; pending: ${pending.join(", ") || "none"}`);
}

// Runs a registered shortcut's action by id, skipping the key-matching layer
// (that layer's test: matchShortcut in tests\shortcuts-core.test.mjs).
function driveShortcut(id: string) {
  const reg = getRegistry();
  const s = reg.find((x) => x.id === id);
  if (!s) throw new Error(`unknown shortcut "${id}"; valid: ${reg.map((x) => x.id).join(", ")}`);
  const activeBefore = sessionsDriveSnapshot().activeId;
  s.run();
  return { id: s.id, name: s.name, activeBefore, activeAfter: sessionsDriveSnapshot().activeId };
}

/** `window.__vidarDrive.shown()`: the launcher's shown roots, the shown Rendered variants (ids, `root/label` for a
 *  key-less row), whether onboarding is up, and whether the dependency report landed. Read-only. */
export function driveShown(): DriveShown {
  const src = deps?.shown;
  if (!src) return { roots: [], rendered: [], onboarding: false, depsLanded: false };
  const roots = src.roots();
  const rootId = (r: DriveAgentType) => r.key ?? r.id;
  return {
    roots: roots.map(rootId),
    rendered: roots.flatMap((r) => src.variants(r).filter((v) => v.body === "rendered").map((v) => v.key ?? `${rootId(r)}/${v.label ?? v.id}`)),
    onboarding: src.onboardingOpen(),
    depsLanded: src.depsLanded(),
  };
}

export function initDrive(d: DriveDeps): void {
  deps = d;
  window.__vidarDrive = {
    openTab: driveOpenTab, send: driveSend, answer: driveAnswer, state: driveStateHosted,
    shortcut: driveShortcut, paste: drivePaste, card: driveCard, shown: driveShown,
  };
}
