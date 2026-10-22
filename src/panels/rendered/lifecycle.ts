// Agent lifecycle of a Rendered body: spawn (and Retry), send, stop (kill or detach), and
// what a process exit leaves behind in the transcript and the status bar.

import type { AgentAdapter, AgentEvent, PermissionMode } from "../../agents/protocol";
import { prettyModel } from "../../format";
import type { AgentTransport } from "./transport";
import { registerRoute, releaseRoute, routeOf, type HostPayload, type Live } from "./host-router";
import { btn, el } from "./dom";
import type { RenderedOpts } from "./opts";
import type { Group, RenderedState, StatusLine, ToolRecord } from "./state";
import { modeLabel } from "./status-bar";
import type { HydrateStats } from "./hydrate-stats";
import { closeHydration } from "./host-payload";
import { initCodexPlans } from "../../agents/codex-plan-store";
import { AGENT_EXITED, denyWithin } from "./cards";
import { bareNotices } from "./notice-actions";

/** The spawn error for a home-folder Codex launch: equals `HOME_CWD_REFUSED` in src-tauri/src/codex_cwd.rs
 *  (tests/codex-home-refused.test.mjs keeps the two in step). */
export const HOME_CWD_REFUSED = "Codex Can't Start in Your Home Folder: Pick a Project Folder";

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
  async function stopAgent(detach = false): Promise<void> {
    // a spawn still resolving has not assigned `gen` yet; killing before it lands
    // targets the previous process and orphans this one
    if (S.spawning) { try { await S.spawning; } catch { /* it failed; there is nothing to kill */ } }
    if (!S.isAlive) return;
    // an open card is denied before the interrupt goes out: an interrupt while the agent waits
    // on a permission makes the SDK throw (A7). A detach leaves the card to the host. A hosted
    // deny can block up to its 40 s request timeout, so Close and /clear wait 2 s at most.
    if (!detach && S.pendingApproval && denyPending) await denyWithin(denyPending);
    if (!detach && S.inTurn) {
      await sendEncoded(S.adapter.encodeInterrupt());
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
    const p = spawnInner().finally(() => { if (S.spawning === p) S.spawning = null; });
    S.spawning = p;
    return p;
  }
  async function spawnInner(): Promise<void> {
    if (opts.agent === "codex") await initCodexPlans();
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
    sl.mode = modeLabel(S.mode); // the control exists from spawn, not from the first session event
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
      noticeBlock(`Failed to Start: ${String(e)}`, "error");
      sl.model = "—"; // never spawned, so "Starting…" is a claim about a process that does not exist
      redrawStatus();
      refreshState(); // the chip is still on "Starting…" without this
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
  async function send(line: string): Promise<boolean> {
    if (!S.isAlive || S.hydrating || S.disconnected || S.disposed) return false;
    try {
      await transport.send(opts.tabId, S.gen, line);
      return true;
    } catch (e) {
      if (!alreadyAnswered(String(e))) noticeBlock(`send failed: ${String(e)}`, "error");
      return false;
    }
  }
  return { send, spawn, stopAgent, onExit };
}
