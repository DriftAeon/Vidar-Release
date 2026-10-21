// Read-only tab lookups for the rest of the app: ids, titles, kinds, launch info, the focused
// session and the drive snapshot. sessions.ts binds its tab map and active id in and re-exports these.
import { invoke } from "../../ipc";
import { mintTabName } from "../../tab-names";
import { holdsCodexThread, launchLineThread, pickRawThreads, rolloutKey, type RawThreadTab, type RolloutThread } from "./codex-thread";
import type { RenderedBody } from "../rendered";
import type { PermissionMode } from "../../agents/protocol";
import type { RulesLaunch } from "../../rules/inject";
import type { LaunchOpts, SessionAgent, SessionBody, TerminalSession } from "./types";

let sessions: ReadonlyMap<string, TerminalSession> = new Map();
let getActiveId: () => string | null = () => null;

/** sessions.ts, at load: the tab map and the focused tab id (read live at each call). */
export function bindLookup(deps: { sessions: ReadonlyMap<string, TerminalSession>; getActiveId: () => string | null }) {
  sessions = deps.sessions;
  getActiveId = deps.getActiveId;
}

/** A themed name no open tab's title uses (tab-names.ts), for a tab opened without a title. */
export function nextTabName(): string {
  return mintTabName([...sessions.values()].map((s) => s.button.title));
}

/** True when an open tab's title is `name` (trimmed, case-insensitive). */
export function tabTitleTaken(name: string): boolean {
  const want = name.trim().toLowerCase();
  return [...sessions.values()].some((s) => s.button.title.trim().toLowerCase() === want);
}

export interface FocusedSession {
  id: string;
  title: string;
  agent: SessionAgent;
  /** the tab mark's roster type id (leftbar.css data-art): agent, or a gateway module id */
  art: string;
  cwd: string;
  model?: string;
  launchArgs?: string[];
  role?: LaunchOpts["role"];
  /** launch profile of the tab ("bare"): observers read that profile's own Claude home */
  profile?: string;
}

/** Claude session ids held by rendered tabs right now (the launcher's Resume list greys them) */
export function openRenderedSessionIds(): string[] {
  return [...sessions.values()].map((s) => s.rendered?.sessionId() ?? "").filter(Boolean);
}

/** The tab (other than `exceptTab`) holding Codex thread `thread` in a Rendered body or a Raw
 *  tab (its resolved thread, else its `codex resume` line), or null; a Codex resume refuses a
 *  held thread (codex-thread.ts). Call `refreshRawCodexThreads` first for a current answer. */
export function codexThreadHolder(thread: string, exceptTab?: string): string | null {
  for (const [id, s] of sessions) {
    if (id !== exceptTab && holdsCodexThread(s, thread, rawThreads.has(id) ? rawThreads.get(id) : undefined)) return id;
  }
  return null;
}

/** Raw Codex tab id → its PTY spawn time (terminal-body.ts), the floor for its own rollouts. */
const rawSpawnMs = new Map<string, number>();
/** Raw Codex tab id → the thread `refreshRawCodexThreads` last resolved (null: none held). */
let rawThreads = new Map<string, string | null>();

/** terminal-body.ts, at a Raw Codex tab's PTY spawn. */
export function noteRawCodexSpawn(id: string, ms = Date.now()): void {
  rawSpawnMs.set(id, ms);
}

type RolloutFetch = (cwd: string, profile: string | null) => Promise<RolloutThread[]>;
const fetchRollouts: RolloutFetch = (cwd, profile) => invoke("codex_rollout_threads", { cwd, profile });

/** Re-resolve every live Raw Codex tab's thread from its own home's rollouts (codex-thread.ts
 *  pickRawThreads). One read per (home, cwd). A read that fails leaves its tabs on their launch
 *  line, as before this existed. */
export async function refreshRawCodexThreads(fetch: RolloutFetch = fetchRollouts): Promise<void> {
  const raws: RawThreadTab[] = [];
  const held: string[] = [];
  for (const [id, s] of sessions) {
    if (s.agent !== "codex" || !s.alive) continue;
    const sid = s.rendered?.sessionId();
    if (sid) held.push(sid);
    const spawnedMs = rawSpawnMs.get(id);
    if (s.body !== "terminal" || spawnedMs === undefined || !s.cwd) continue;
    raws.push({ id, cwd: s.cwd, profile: s.profile ?? null, spawnedMs, launchThread: launchLineThread(s.launchArgs) });
  }
  for (const id of rawSpawnMs.keys()) if (!sessions.has(id)) rawSpawnMs.delete(id);
  const rollouts = new Map<string, RolloutThread[]>();
  await Promise.all([...new Set(raws.map((t) => rolloutKey(t.profile, t.cwd)))].map(async (key) => {
    const t = raws.find((r) => rolloutKey(r.profile, r.cwd) === key)!;
    try {
      rollouts.set(key, await fetch(t.cwd, t.profile));
    } catch (e) {
      console.error("codex rollout threads:", e);
    }
  }));
  // a tab whose home could not be read keeps its launch line (never resolved)
  const readable = raws.filter((t) => rollouts.has(rolloutKey(t.profile, t.cwd)));
  rawThreads = pickRawThreads(readable, rollouts, held);
}

/** A Rendered tab's Claude session id, read live at the call (the Runes tab's query); null for a
 *  Raw tab, an unknown id or a session not started yet. Never snapshotted onto FocusedSession. */
export function renderedSessionId(id: string): string | null {
  return sessions.get(id)?.rendered?.sessionId() ?? null;
}

/** Falcon host ids already represented by Vidar tabs (the Hosted picker greys them). */
export async function openFalconSessionIds(): Promise<string[]> {
  return (await falconTabPairs("record")).map((p) => p.session);
}

/** `findTabByFalconSession` plus spawned hosted tabs (`falconTabPairs`); jettison and adoptHosted's guard. */
export async function findTabByFalconSessionHosted(session: string): Promise<string | null> {
  const match = await resolveFalconTab(session, "record");
  return match?.isCurrent() ? match.id : null;
}

/** "record": the same tab record, body and Falcon attachment, enough for "does any tab host X"
 *  (a spawned tab's Claude sessionId arriving mid-lookup must not hide it from the adopt guard).
 *  "full" adds the Claude sessionId and hosted flag, for a cached mapping (tab-state-feeds). */
export type FalconTabScope = "record" | "full";

/** Capture the tab record and attachment identity before an async lookup. */
export function captureFalconTabIdentity(id: string, scope: FalconTabScope = "full"): () => boolean {
  const tab = sessions.get(id);
  const body = tab?.rendered;
  const kind = tab?.body;
  const falcon = tab?.falconSession;
  const record = () => !!tab && sessions.get(id) === tab && tab.rendered === body && tab.body === kind
    && tab.falconSession === falcon;
  if (scope === "record") return record;
  const session = body?.sessionId();
  const hosted = body?.hosted();
  return () => record() && body?.sessionId() === session && body?.hosted() === hosted;
}

export interface FalconTabMatch {
  id: string;
  session: string;
  isCurrent: () => boolean;
}

/** Keep the identity guard with the result for callers that await other lookups before using it.
 *  `pairs` lets a caller resolving several sessions share one `falconTabPairs` pass (one IPC per hosted tab). */
export async function resolveFalconTab(
  session: string,
  scope: FalconTabScope = "full",
  pairs: () => Promise<FalconTabMatch[]> = () => falconTabPairs(scope),
): Promise<FalconTabMatch | null> {
  const id = findTabByFalconSession(session);
  if (id) return { id, session, isCurrent: captureFalconTabIdentity(id, scope) };
  return (await pairs()).find((p) => p.session === session && p.isCurrent()) ?? null;
}

/** A hosted tab's Falcon session from Rust's `falcon.hosted` map, or null (unknown tab, not yet
 *  attached, or the invoke failed). A spawned hosted tab needs this: only adopted tabs carry
 *  `falconSession` (`falconTabPairs`, the drive state's `driveStateHosted`). */
export async function hostedFalconSession(id: string): Promise<string | null> {
  return hostedSessionWhile(id, captureFalconTabIdentity(id));
}

async function hostedSessionWhile(id: string, isCurrent: () => boolean): Promise<string | null> {
  if (!isCurrent()) return null;
  const session = await invoke("falcon_hosted_session", { id }).catch(() => null);
  return isCurrent() ? session : null;
}

/** Guarded Falcon identity per hosted tab; a spawned tab has no `falconSession`, so Rust's `falcon.hosted` answers. */
export async function falconTabPairs(scope: FalconTabScope = "full"): Promise<FalconTabMatch[]> {
  const pairs = await Promise.all([...sessions].map(async ([id, s]): Promise<FalconTabMatch | null> => {
    const isCurrent = captureFalconTabIdentity(id, scope);
    const session = s.falconSession || (s.rendered?.hosted() ? await hostedSessionWhile(id, isCurrent) : null);
    return session && isCurrent() ? { id, session, isCurrent } : null;
  }));
  // recheck after the aggregate: a tab whose lookup finished early may have changed while another waited
  return pairs.filter((p): p is FalconTabMatch => !!p && p.isCurrent());
}

/** Full per-tab snapshot for the drive hook (window.__vidarDrive.state(), main.ts):
 *  everything `driveSend`/`driveAnswer`'s caller needs to pick a tab, plus which one
 *  is active. `renderedDrive` is the companion — a rendered tab's own chips and
 *  pending cards, kept separate because merging it in is main.ts's job (plan). */
export function driveSnapshot(): {
  activeId: string | null;
  tabs: { id: string; title: string; agent: SessionAgent; body: SessionBody; cwd: string | null; hosted: boolean; sessionId: string | null; falconSession: string | null; active: boolean }[];
} {
  return {
    activeId: getActiveId(),
    // page tabs (openPageTab) are not sessions a drive can send to
    tabs: [...sessions.values()].filter((s) => s.body !== "page").map((s) => ({
      id: s.id,
      title: s.button.title,
      agent: s.agent,
      body: s.body,
      cwd: s.cwd || null, // "" = no folder known (createSession); the backend picked
      hosted: !!s.rendered?.hosted(),
      sessionId: s.rendered?.sessionId() ?? null,
      falconSession: s.falconSession ?? null,
      active: s.id === getActiveId(),
    })),
  };
}

/** A rendered tab's own `drive()` snapshot (chips + pending cards), or null for an
 *  unknown id or a non-rendered tab — the `sessions` map stays private to this module. */
export function renderedDrive(id: string): ReturnType<RenderedBody["drive"]> | null {
  return sessions.get(id)?.rendered?.drive() ?? null;
}

/** What the last `vidar-focus` carried: a listener that mounts after the boot dispatch (a
 *  capability panel) seeds from this instead of waiting for the next tab switch. */
export function getFocusedSession(): FocusedSession | null {
  const activeId = getActiveId();
  const s = activeId ? sessions.get(activeId) : undefined;
  // A page tab reads null: every listener clears its target on null, while
  // skipping the event would leave them pointing at the previous shell tab.
  return s && s.alive && s.body !== "page"
    ? { id: s.id, title: s.container.dataset.title ?? s.id, agent: s.agent, art: s.button.dataset.art ?? s.agent, cwd: s.cwd, model: s.model, launchArgs: s.launchArgs, role: s.role, profile: s.profile }
    : null;
}

/** True for a page tab (openPageTab): a tab with nothing to type into. */
export function isPageTab(id: string): boolean {
  return sessions.get(id)?.body === "page";
}

/** A tab's display title (the user's rename, if they made one), or null when
 *  no such tab exists — the ask gate names the asker with it. */
export function sessionTitle(id: string): string | null {
  return sessions.get(id)?.button.title ?? null;
}

/** A named tab's agent kind and body. By id, not the active tab: voice pins its
 *  target at hotkey press and writes seconds later, so `getActiveSessionAgent()`
 *  would answer about whichever tab the user switched to meanwhile.
 *  `agent` is set once at creation and never updated — a Claude tab whose REPL
 *  the user exited still reads "claude". Callers that care must say so. */
export function sessionKind(id: string): { agent: SessionAgent; body: SessionBody } | null {
  const s = sessions.get(id);
  return s ? { agent: s.agent, body: s.body } : null;
}

/** The live `RenderedBody` for a tab, or null for a terminal tab or an id
 *  that doesn't exist (`isBusy`/`sessionId`/`write` on a specific tab,
 *  not necessarily the active one). */
export function renderedBody(id: string): RenderedBody | null {
  return sessions.get(id)?.rendered ?? null;
}

/** What a tab was launched with, for a successor spawn — same
 *  agent, cwd, model, launch args and permission mode as the source tab. */
export function sessionLaunchInfo(id: string): {
  agent: SessionAgent;
  cwd: string;
  model?: string;
  launchArgs?: string[];
  permissionMode?: PermissionMode;
  rules?: RulesLaunch;
  profile?: string;
  rowKey?: string;
} | null {
  const s = sessions.get(id);
  if (!s || s.body === "page") return null; // a page tab has no successor to spawn
  // the successor keeps the tab's rules; its warnings were shown once already
  const rules = s.rules ? { ...s.rules, warnings: [] } : undefined;
  // and its launch profile: a bare tab's successor is bare, never a default tab
  return { agent: s.agent, cwd: s.cwd, model: s.model, launchArgs: s.launchArgs, permissionMode: s.permissionMode, rules, profile: s.profile, rowKey: s.rowKey };
}

/** the focused tab's START cwd (the workspace review binds to it) */
export function getActiveSessionCwd(): string | null {
  const activeId = getActiveId();
  const session = activeId ? sessions.get(activeId) : undefined;
  return session && session.body !== "page" ? session.cwd : null;
}

export function getActiveSessionAgent(): SessionAgent | null {
  const activeId = getActiveId();
  const session = activeId ? sessions.get(activeId) : undefined;
  return session?.alive && session.body !== "page" ? session.agent : null;
}

/** The pane element a session renders into; null for an unknown id. Lets voice.ts
 *  anchor its overlay by exact session id instead of parsing the counter out of it. */
export function sessionContainer(id: string): HTMLElement | null {
  return sessions.get(id)?.container ?? null;
}

/** The Vidar tab id currently showing `session` (a Falcon session id) as its
 *  `falconSession`, if any — used by the `jettison` ask-gate branch (`src/control/open-ask.ts`)
 *  to turn a session id from `$env:FALCON_SESSION` back into a tab. */
export function findTabByFalconSession(session: string): string | null {
  for (const [id, s] of sessions) {
    if (s.falconSession === session) return id;
  }
  return null;
}
