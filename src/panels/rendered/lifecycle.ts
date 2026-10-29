// Agent lifecycle of a Rendered body: spawn (and Retry), send, stop (kill or detach), and
// what a process exit leaves behind in the transcript and the status bar.

import type { AgentAdapter, AgentEvent, PermissionMode } from "../../agents/protocol";
import { prettyModel } from "../../format";
import { runeGuardCard, runeGuardRefusal } from "./rune-guard-error";
import type { AgentTransport } from "./transport";
import { registerRoute, releaseRoute, routeOf, type HostPayload, type Live } from "./host-router";
import { btn, el } from "./dom";
import type { RenderedOpts } from "./opts";
import type { Group, RenderedState, StatusLine, ToolRecord } from "./state";
import { modeLabel } from "./status-bar";
import type { HydrateStats } from "./hydrate-stats";
import { closeHydration } from "./host-payload";
import { AGENT_PROFILE } from "../../agents/agent-profile";
import { AGENT_EXITED, denyWithin } from "./cards";
import { bareNotices, vidarFolderCard } from "./notice-actions";

/** The spawn error for a home-folder Codex launch: equals `HOME_CWD_REFUSED` in src-tauri/src/codex_cwd.rs
 *  (tests/codex-home-refused.test.mjs keeps the two in step). */
/** How long a send released from a respawn's hold waits for the new session's replay to end. */
const HELD_HYDRATION_MS = 15000;

export const HOME_CWD_REFUSED = "Codex Can't Start in Your Home Folder: Pick a Project Folder";

/** The spawn error for a Vidar-folder Codex launch: equals `VIDAR_CWD_REFUSED` in src-tauri/src/bare/mod.rs
 *  (tests/codex-home-refused.test.mjs keeps the two in step). */
export const VIDAR_CWD_REFUSED = "Codex Can't Start in Vidar's Folder: Its Sandbox Could Write Vidar's Launch Files";

/** What the lifecycle closes over in createRenderedBody. */
export interface LifecycleDeps {
  opts: RenderedOpts;
  transport: AgentTransport;
  root: HTMLElement;
  sl: StatusLine;
  queued: { text: string; host: HTMLElement }[];
  tools: Map<string, ToolRecord>;
  newAdapter: () => AgentAdapter;
  handle: (ev: AgentEvent) => void;
  hostPayload: (payload: HostPayload) => void;
  markUndelivered: (host: HTMLElement, why: string) => void;
  cancelApprovals: (reason: string) => void;
  /** deny every open card as Esc does (cards.ts); optional so a harness without cards skips it */
  denyPending?: () => Promise<void>;
  alreadyAnswered: (text: string) => boolean;
  stalePill: (t: { details: HTMLDetailsElement; group: Group | null }) => void;
  sealGroup: () => void;
  settleThoughts: () => void;
  clearWaiting: () => void;
  settleSwitch: (confirmed: PermissionMode | null) => void;
  resetCache: () => void;
  stopCacheTimer: () => void;
  drawCache: () => void;
  redrawStatus: () => void;
  resetTranscript: () => void;
  setInTurn: (on: boolean) => void;
  refreshState: () => void;
  append: (node: HTMLElement, parent?: HTMLElement) => void;
  noticeBlock: (text: string, level: "info" | "warn" | "error", quiet?: boolean) => void;
  sendEncoded: (line: string | null) => Promise<boolean>;
  stats: HydrateStats;
  openHydratedCards: () => void;
  /** `claude auth status` for this tab (rendered/login.ts); run on every successful spawn */
  checkLogin: () => void;
}

export function createLifecycle(S: RenderedState, deps: LifecycleDeps) {
  const {
    opts, transport, root, sl, queued, tools, newAdapter, handle, hostPayload, markUndelivered,
    cancelApprovals, denyPending, alreadyAnswered, stalePill, sealGroup, settleThoughts, clearWaiting, settleSwitch,
    resetCache, stopCacheTimer, drawCache, redrawStatus, resetTranscript, setInTurn, refreshState,
    append, noticeBlock, sendEncoded, stats, openHydratedCards, checkLogin,
  } = deps;
  /** Resolves once the current turn ends, or after `timeoutMs` — whichever is
   *  first. Used by `stopAgent` to give an interrupted turn a beat to wind
   *  down before the kill lands on it. */
  function waitForTurnEnd(timeoutMs: number): Promise<void> {
    if (!S.inTurn) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        S.turnEndWaiters = S.turnEndWaiters.filter((w) => w !== settle);
        resolve();
      }, timeoutMs);
      const settle = () => { window.clearTimeout(timer); resolve(); };
      S.turnEndWaiters.push(settle);
    });
  }
  function onExit(code: number | null) {
    if (!S.isAlive) return;
    S.isAlive = false;
    S.characterTurnOpen = false;
    setInTurn(false); // refreshState → syncCharacterActive
    settleThoughts();
    // The process died with messages still queued — they were never sent, and
    // saying so is the whole point of drawing them. Click still recovers the text.
    for (const q of queued) markUndelivered(q.host, "Never sent — the agent exited first. Click to take it back.");
    queued.length = 0;
    // drafts the adapter itself held (Codex: queued for the thread, or on its login read) come back too
    for (const ev of S.adapter.exited?.() ?? []) handle(ev);
    cancelApprovals(AGENT_EXITED);
    for (const t of tools.values()) {
      const c = t.details.classList;
      if (c.contains("running") || c.contains("pending")) stalePill(t);
    }
    sealGroup();
    root.classList.add("dead");
    stopCacheTimer(); // onExit is not a teardown path: without this a dead tab ticks forever
    clearWaiting(); // the process died: any background agent it launched is gone with it
    drawCache();
    refreshState();
    const line = el("div", "blk blk-exit");
    line.append(el("span", "", `Process exited${code !== null ? ` (${code})` : ""} — `));
    line.appendChild(btn(S.sessionId ? "Resume" : "Restart", "rendered-resume", () => { line.remove(); void spawn(); }));
    append(line);
    opts.onDead();
  }

  /* -- backend -- */

  /** Kill the running agent without touching the transcript (shared by shutdown, /clear and
   *  Jettison). The route's exit is latched for the kill window, so an exit fired before the
   *  kill resolves never reaches onExit; the route is dropped once the kill succeeds. If the
   *  host refuses, the exit is restored and a latched exit is replayed before rethrowing. */
  async function stopAgent(detach = false, held = false): Promise<void> {
    // a spawn still resolving has not assigned `gen` yet; killing before it lands
    // targets the previous process and orphans this one
    if (S.spawning) { try { await S.spawning; } catch { /* it failed; there is nothing to kill */ } }
    if (!S.isAlive) return;
    // an open card is denied before the interrupt goes out: an interrupt while the agent waits
    // on a permission makes the SDK throw (A7). A detach leaves the card to the host. A hosted
    // deny can block up to its 40 s request timeout, so Close and /clear wait 2 s at most.
    if (!detach && S.pendingApproval && denyPending) await denyWithin(denyPending);
    if (!detach && S.inTurn) {
      // under a respawn's send hold (`held`) the interrupt skips the queue it would otherwise wait in forever
      const stop = S.adapter.encodeInterrupt();
      await (held ? (stop === null ? true : sendNow(stop)) : sendEncoded(stop));
      await waitForTurnEnd(5000); // give the interrupted tool call a beat to wind down before the kill
    }
    const g = S.gen;
    // Latch the exit for the kill window: an exit the transport fires before kill resolves
    // (same gen, so it still binds) must not reach onExit and mark the tab dead. Lines and
    // host payloads keep flowing, so a refused detach leaves no transcript gap.
    const route = routeOf(opts.tabId);
    const routedExit = route?.exit;
    let exited: { code: number | null } | null = null;
    if (route) route.exit = (code) => { exited = { code }; };
    try {
      if (detach && transport.detach) await transport.detach(opts.tabId, g);
      else await transport.kill(opts.tabId, g);
    } catch (e) {
      // Keep the view usable when the host refuses an explicit lifecycle action; an exit that
      // did arrive (host closed the session, then the request failed) still marks the tab dead.
      if (route && routedExit) route.exit = routedExit;
      const late = exited as { code: number | null } | null;
      if (late && route && routeOf(opts.tabId) === route && !S.disposed) route.exit(late.code);
      throw e;
    }
    if (route && routedExit) route.exit = routedExit;
    if (route) releaseRoute(opts.tabId, route); // a late exit finds no route
    S.isAlive = false;
  }
  let rulesNoted = false; // prepare-time warnings land once per body, not on every Resume or Retry
  function spawn(): Promise<void> {
    // the chip reads Starting… while a spawn is in flight (state-chip.ts): repaint once it clears. spawnInner starts
    // a microtask later, so S.spawning is already set when its own status paint runs (with a pinned model the
    // status line never reads "Starting…", and that paint read Ready: E1 run 4, case 2)
    const p = Promise.resolve().then(spawnInner).finally(() => { if (S.spawning === p) { S.spawning = null; if (!S.disposed) refreshState(); } });
    S.spawning = p;
    return p;
  }
  async function spawnInner(): Promise<void> {
    const before = AGENT_PROFILE[opts.agent].beforeSpawn;
    if (before) await before();
    if (S.disposed) return; // The body may close while its plan snapshots load.
    S.adapter = newAdapter();
    cancelApprovals("session restarted");
    if (S.sessionId) resetTranscript(); // history comes back through the replay
    if (!rulesNoted) { rulesNoted = true; for (const w of opts.rules?.warnings ?? []) noticeBlock(w, "warn"); }
    const route: Live = { gen: -1, floor: S.gen, adapter: S.adapter, handle, host: hostPayload, exit: onExit, dropped: (bytes) => noticeBlock(`a ${(bytes / 1048576).toFixed(1)} MiB line was dropped by the pipe; the reply may be incomplete`, "warn") };
    registerRoute(opts.tabId, route);
    S.isAlive = true;
    root.classList.remove("dead");
    // a /model switch or effort change made mid-session survives Retry/Resume (as the mode does)
    const model = (S.characterModelLive ? S.characterModel : null) ?? opts.model ?? null;
    const effort = S.liveEffort ?? opts.effort ?? null;
    sl.model = model ? prettyModel(model) : "Starting…";
    S.modelHinted = false;
    if (S.switchPending) settleSwitch(null); // a switch can't outlive the process it was sent to
    sl.mode = modeLabel(S.mode, opts.agent); // the control exists from spawn, not from the first session event
    resetCache(); // a new process has no warm prefix of ours
    redrawStatus();
    try {
      const spawned = await transport.spawn({
        tabId: opts.tabId,
        tabName: opts.tabName,
        agent: opts.agent,
        cwd: opts.cwd,
        model,
        effort,
        permissionMode: S.mode, // a switched mode survives Retry/Resume
        resume: S.sessionId,
        rules: opts.rules,
        onBareWarnings: (ws, trust) => bareNotices({
          tabId: opts.tabId, agent: opts.agent, cwd: opts.cwd, append, sealGroup,
          ...(opts.onReopenHere ? { reopenHere: opts.onReopenHere, hasTurns: () => root.querySelector(".blk-user") !== null } : {}),
        }, ws, trust),
      });
      const g = spawned.gen;
      if (S.disposed || routeOf(opts.tabId) !== route) {
        // The spawn completed after its view retired. Cleanup is bound to the returned generation;
        // hosted sessions survive view disposal, so release their view instead of killing them.
        try {
          if (transport.durable) await transport.detach?.(opts.tabId, g);
          else await transport.kill(opts.tabId, g);
        } catch (error) { console.warn(`retired spawn cleanup: ${String(error)}`); }
        return;
      }
      if (route.gen === -1) route.gen = g;
      S.gen = route.gen;
      // an exit that bound before spawn resolved already ran onDead; don't overwrite it
      if (S.isAlive && routeOf(opts.tabId) === route) opts.onAlive?.();
      opts.onAdopted?.(true);
      checkLogin(); // a login in a terminal since the last spawn (/clear, Retry) clears the warning here
      // a request/response adapter (Codex) opens its own session now; Claude's is a no-op
      S.adapter.attach((line) => (routeOf(opts.tabId) === route ? send(line) : Promise.resolve(false)), handle);
      S.adapter.start({ cwd: opts.cwd, model: model ?? undefined, effort: effort ?? undefined, permissionMode: S.mode, resume: S.sessionId ?? undefined, ...(spawned.developerInstructions ? { developerInstructions: spawned.developerInstructions } : {}) });
    } catch (e) {
      if (S.disposed || routeOf(opts.tabId) !== route) return;
      opts.onAdopted?.(false, String(e));
      // an errored replay never sends `hydration: end`: close the meter and open the
      // still-pending cards as the normal end does (host-payload.ts)
      closeHydration(S, stats, openHydratedCards);
      root.inert = false;
      releaseRoute(opts.tabId, route);
      S.isAlive = false;
      root.classList.add("dead");
      const openWt = opts.onOpenWorktree;
      const vidarCard = openWt && String(e).includes(VIDAR_CWD_REFUSED);
      const runeRefusal = runeGuardRefusal(e);
      if (!vidarCard && !runeRefusal) noticeBlock(`Failed to Start: ${String(e)}`, "error");
      sl.model = "—"; // never spawned, so "Starting…" is a claim about a process that does not exist
      redrawStatus();
      refreshState(); // the chip is still on "Starting…" without this
      if (runeRefusal) {
        append(runeGuardCard(opts.tabId, runeRefusal, async (fresh) => {
          // A variant moved the tab: a resume would load the old thread's vault, so start a fresh session
          if (fresh) { S.sessionId = null; sl.ctxTokens = 0; sl.ctxPct = null; resetTranscript(); }
          await spawn();
        }));
        opts.onDead();
        return;
      }
      if (vidarCard && openWt) {
        // Retry fails the same way here; the card opens a worktree and replaces this tab
        append(vidarFolderCard(openWt));
        opts.onDead();
        return;
      }
      const retry = el("div", "blk blk-exit");
      retry.appendChild(btn("Retry", "ws-btn rendered-retry", () => { retry.remove(); void spawn(); }));
      const pick = opts.onSelectWorkspace;
      if (pick && String(e).includes(HOME_CWD_REFUSED)) {
        // Retry fails the same way here; a folder pick opens a new tab and closes this one
        const sel = btn("Select Workspace…", "rendered-resume", () => {
          sel.disabled = true;
          pick().then(() => { sel.disabled = false; }, (err) => {
            sel.disabled = false;
            noticeBlock(String(err instanceof Error ? err.message : err), "error");
          });
        });
        retry.appendChild(sel);
      }
      append(retry);
      opts.onDead();
    }
  }
  /** Sends hold while a respawn or a spawn has no generation yet (D-d): a line sent then would reach the old
   *  process, or no process. `holdSends` returns the release; send() re-checks after every release. `S.holding`
   *  mirrors the hold, so the chip reads Starting… and `write()` refuses from the respawn's first step. */
  let nextGen: Promise<void> | null = null;
  function holdSends(): () => void {
    let release!: () => void;
    const p = new Promise<void>((r) => { release = r; });
    nextGen = p;
    S.holding = true;
    refreshState();
    return () => {
      if (nextGen === p) { nextGen = null; S.holding = false; if (!S.disposed) refreshState(); }
      release();
    };
  }
  /** A hosted spawn resolves before its replay ends (`hydration: end` comes later from the reader thread), so a send
   *  released from a hold waits out that hydration, bounded, rather than being refused by it. */
  async function hydrated(): Promise<void> {
    const end = Date.now() + HELD_HYDRATION_MS;
    while (S.hydrating && S.isAlive && !S.disposed && Date.now() < end) {
      await new Promise<void>((r) => { window.setTimeout(r, 50); });
    }
  }
  /** A fresh session in this tab through the /clear route (a Rune Vault edit, D-d): open cards are denied, the
   *  agent stops, the transcript and context clear, and a new process spawns with no resume. Sends made meanwhile
   *  wait for the new generation; a send that still cannot go returns false, so the composer keeps its text. */
  async function respawnFresh(): Promise<void> {
    if (S.disposed) return;
    if (S.pendingApproval && denyPending) await denyWithin(denyPending); // before the hold: the deny is a send
    const release = holdSends();
    try {
      await stopAgent(false, true);
      S.sessionId = null;
      sl.ctxTokens = 0;
      sl.ctxPct = null;
      resetTranscript();
      await spawn();
    } finally { release(); }
  }
  async function send(line: string): Promise<boolean> {
    let held = false;
    while (nextGen) { held = true; await nextGen; }
    if (held) await hydrated();
    return sendNow(line);
  }
  async function sendNow(line: string): Promise<boolean> {
    if (!S.isAlive || S.hydrating || S.disconnected || S.disposed) return false;
    try {
      await transport.send(opts.tabId, S.gen, line);
      return true;
    } catch (e) {
      if (!alreadyAnswered(String(e))) noticeBlock(`send failed: ${String(e)}`, "error");
      return false;
    }
  }
  return { send, spawn, stopAgent, onExit, respawnFresh };
}
