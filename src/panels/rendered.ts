// Rendered body: a session tab whose agent runs headless (Claude via
// tools\claude-sidecar.mjs inside the Falcon host, src-tauri\src\falcon.rs;
// Codex via src-tauri\src\agent.rs) and whose
// transcript Vidar draws from protocol.ts events instead of a TUI grid. One
// module-level listener pair (rendered/host-router.ts) routes `agent-event` / `agent-exit` by tab id,
// like sessions.ts does for the pty; every event also carries the backend
// generation and a stale one is ignored (a re-spawned tab keeps its id).
//
// Contract with sessions.ts: `write(data)` is the same injection seam the
// pty has — text lands UNSENT in the composer, a trailing "\r" submits, and
// any other CR inside the text becomes a newline and can never submit.
// Every agent-supplied string reaches the DOM via textContent or the
// document builder; nothing is innerHTML. Unknown events are shown, never
// dropped.

import type { AgentAdapter, PermissionMode, Usage } from "../agents/protocol";
import { titleCase } from "../format";
import { cardsSnapshot, DRIVE_CLASS } from "./rendered-drive";
import { bundleChip, BUNDLE_CHIP_TIP } from "./bundle-version";
import { tauriAgentTransport } from "./rendered/transport";
import { ensureListeners, releaseAdapterRoute } from "./rendered/host-router";
import { hostHas } from "./rendered/host-profile";
import { AGENT_PROFILE } from "./rendered/agent-profile";
import { el } from "./rendered/dom";
import { restoredCard } from "./rendered/restored-block";
import { createLatestPill } from "./rendered/latest-pill";
import { userBlockFor } from "./rendered/user-block";
import { createFollow, createSendStick } from "./rendered/follow";
import { wireTranscriptFocus } from "./rendered/transcript-focus";
import type { RenderedState, ToolRecord } from "./rendered/state";
import { createCards } from "./rendered/cards";
import { createEvents } from "./rendered/events";
import { initialState } from "./rendered/initial-state";
import { createLocalCommand } from "./rendered/local-command";
import { bindStickScroll } from "./rendered/stick-scroll";
import { createComposer } from "./rendered/composer";
import { createPalette } from "./rendered/palette";
import { createCacheCell } from "./rendered/cache-cell";
import { createAgentsBlock } from "./rendered/agents-block";
import { createAskMirror } from "./rendered/ask-mirror";
import { createGroups } from "./rendered/groups";
import { createTextStream } from "./rendered/text-stream";
import { createToolPills, OUTPUT_SHOW_MAX } from "./rendered/tool-pills";
import { createStMenu } from "./rendered/st-menu";
import { createStatusBar, modeLabel as permissionModeLabel } from "./rendered/status-bar";
import { createHostPayload } from "./rendered/host-payload";
import { createHydrateStats } from "./rendered/hydrate-stats";
import { createLifecycle } from "./rendered/lifecycle";
import { authCheck, createLogin } from "./rendered/login";
import { API_KEY_CARD } from "./rendered/api-key-card";
import { createBang } from "./rendered/bang";
import { chipState } from "./rendered/state-chip";
import { claudeStatus, tabLogin } from "./rendered/claude-login";
import type { RenderedOpts } from "./rendered/opts";

export {
  createFalconAdoptTransport,
  falconAgentTransport,
  type RenderedAgent,
} from "./rendered/transport";

/** How long `abandon` waits on Falcon before giving up; the tab is already gone by then. */
const ABANDON_BOUND_MS = 5000;

export type { RenderedOpts } from "./rendered/opts";

export interface RenderedBody {
  el: HTMLElement;
  focus(): void;
  write(data: string): Promise<boolean>;
  dispose(): void;
  alive(): boolean;
  hosted(): boolean;
  /** the agent session id once known (for resume/adopt) */
  sessionId(): string | null;
  /** current composer text, for a Jettison/Dock handoff */
  draft(): string;
  /** mid-turn or still hydrating — a caller deciding whether it's safe to close
   *  this tab or hand it a message. */
  isBusy(): boolean;
  /** Messages typed mid-turn and still held in the composer queue (the Falcon shell's reload gate). */
  queuedCount(): number;
  /** A hosted tab whose spawn has resolved and is not hydrating, disconnected or
   *  disposed: `sendPrompt` can reach the host now (ctl lanes, src/control/lanes.ts). */
  promptReady(): boolean;
  /** One user prompt straight to the host — `transport.send(tabId, gen,
   *  adapter.encodeUser(text))`, the composer's durable path without the
   *  composer: the draft is untouched. Resolves once the host accepted it (Falcon
   *  journals it, queued if mid-turn); rejects when not ready or refused. Never retried. */
  sendPrompt(text: string): Promise<void>;
  /** The value the mode switch currently holds — the live mode, not necessarily
   *  the one the tab launched with. */
  permissionMode(): PermissionMode;
  /** interrupt if a turn runs, then kill; resolves when the backend entry is gone */
  shutdown(): Promise<void>;
  /** Drop this view while a durable host continues to own the child. */
  detach(): Promise<void>;
  /** A fresh session in this tab through the /clear route (a Rune Vault edit, D-d); sends meanwhile wait for it. */
  respawnFresh(): Promise<void>;
  /** The host connection reported lost (`hostPayload` disconnected) and no re-hydration since. */
  disconnected(): boolean;
  /** Best-effort close for a view that cannot reach its host: ask Falcon to close the session,
   *  then drop the local view entry if that fails. Bounded, never rejects; failures are logged. */
  abandon(): Promise<void>;
  /** Drive-hook snapshot (window.__vidarDrive): the chips and the pending approval
   *  cards, read live from the status line and the `.blk-approval` DOM — no extra state. */
  drive(): {
    model: string;
    mode: string;
    /** `stateChip.dataset.state` — the stable value ("idle" | "working" | "approval" | "dead" | …). */
    state: string;
    /** the tooltip's first line (human text: "Ready", "Not Logged In", "Waiting for approval", …). */
    stateText: string;
    modeBlocked: boolean;
    /** pending cards only (`.blk-approval:not(.settled)`). */
    cards: { id: string; tool: string; options: string[][]; settled: string | null }[];
    settledCards: number;
  };
}

/* ---- the body ---- */

export function createRenderedBody(opts: RenderedOpts): RenderedBody {
  const modeLabel = (mode: string) => permissionModeLabel(mode, opts.agent);
  // Resolved once. A body does not change backend mid-life: a Falcon-hosted
  // session and an in-process one have different lifetimes, and swapping under
  // a running child is the bug the slice-4 transfer exists to do safely.
  const transport = opts.transport ?? tauriAgentTransport;
  // One adapter per process generation: protocol state (thread, turn, pending
  // requests) must not survive a Resume/Retry re-spawn. A durable (Falcon) transport gets the
  // agent's hosted adapter: the host owns the app-server handshake for Codex.
  const newAdapter = (): AgentAdapter => AGENT_PROFILE[opts.agent].newAdapter(!!transport.durable);
  const S: RenderedState = initialState(opts, newAdapter());
  const root = el("div", "rendered");
  const transcript = el("div", "rendered-transcript");
  transcript.tabIndex = -1;
  // Start pill: exists from body creation so an empty Rendered tab still reads as
  // "something is here" — the sidecar's `session` event (Claude's system/init) only
  // arrives once the first turn starts, so this is enriched in place, never duplicated.
  const agentPill = el("div", "blk blk-agent-pill");
  function renderAgentPill(cwd = S.pillCwd): void {
    S.pillCwd = cwd;
    const dir = titleCase(cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd);
    const parts = [AGENT_PROFILE[opts.agent].label];
    if (S.pillVersion) parts.push(S.pillVersion);
    // no model here: the status bar owns it and follows a switch; this pill only knew init's (2026-10-04)
    parts.push(dir);
    agentPill.textContent = parts.join(" · ");
    const chip = transport.durable && hostHas(opts.host, "installedVersionCheck") ?bundleChip(S.pillVersion, S.pillInstalled) : null;
    if (chip) agentPill.appendChild(Object.assign(el("span", "agent-pill-bundle", chip), { title: BUNDLE_CHIP_TIP }));
  }
  renderAgentPill();
  transcript.appendChild(agentPill);
  const status = el("div", "rendered-status");
  const composerWrap = el("div", "rendered-composer");
  const palette = el("div", "rendered-palette hidden");
  const textarea = el("textarea", "rendered-input"); // no how-to placeholder
  textarea.rows = 4; // four lines before it scrolls (2026-10-05)
  // No red squiggles under paths, flags and identifiers — a prompt is code more
  // often than it is prose, and the browser dictionary flags nearly all of it.
  textarea.spellcheck = false;
  if (opts.draft) textarea.value = opts.draft;
  // One explicit state on the composer: the three
  // signals — alive, pending approval, in-turn — as one chip. Priority: dead >
  // approval > working > ready. It is the status bar's right-hand cell, level
  // with the statusline; the Send button is gone — Enter sends, Esc stops.
  // The chip is the dot alone — colour carries the state, the word was
  // noise next to it. The text survives as the tooltip, so it stays readable.
  const stateChip = el("span", "rendered-state");
  const tools = new Map<string, ToolRecord>();
  const approvals = new Map<string, HTMLElement>(); // pending cards; here so refreshState's relay sync never meets it uninitialised
  const askMirror = createAskMirror({ tabId: opts.tabId, tabName: opts.tabName, tools, approvals, openQuestions: () => openQuestions(), hydrating: () => S.hydrating, host: transcript });
  // built here, where its DOM stood: `tools` is declared just above; the rest are hoisted functions
  const agents = createAgentsBlock(S, { tools, noticeBlock, refreshState, transcript });
  const { waiting, addWaiting, resumeWaiting, taskDone, liveTasks, settleDoneAgents, settleReplayedAgents, clearWaiting } = agents;
  const inputRow = el("div", "rendered-input-row");
  inputRow.append(palette, textarea);
  composerWrap.append(inputRow);
  const latest = createLatestPill(transcript, () => { S.stick = true; });
  const follow = createFollow(transcript, S);
  const sendStick = createSendStick(S);
  const scrollWrap = el("div", "rendered-scroll");
  scrollWrap.append(transcript, latest.el);
  root.append(scrollWrap, agents.el, status, composerWrap);

  const cache = createCacheCell(S);
  const { drawCache, markCacheWarm, stopCacheTimer, resetCache } = cache;
  const { openStMenu, closeStMenu } = createStMenu(S);
  // `send`, `stopAgent` and `spawn` are thunks: lifecycle is built last, and nothing here sends before spawn
  const bar = createStatusBar(S, { opts, send: (line) => send(line), noticeBlock, refreshState, emitCharacterStatus, openStMenu, textarea, login: tabLogin(S, { sendEncoded: (l) => sendEncoded(l), mount: (card) => { sealGroup(); append(card); }, textarea, noticeBlock,
    opts, transport, hostCan: hostHas(opts.host, "loginRun"), loggedIn: () => login.fromAgent(true), stopAgent: () => stopAgent(), spawn: () => spawn() }) });
  const { sl, settleSwitch, settleModel, setModel, pickModelMenu, redrawStatus, modeBtnBlocked } = bar;
  status.append(bar.slParts, cache.el, bar.modeSlot, stateChip);
  function emitCharacterStatus(fresh: boolean): void {
    if (S.hydrating) return;
    const key = JSON.stringify([S.characterModel, sl.ctxPct, fresh]);
    if (key === S.lastCharacterStatus) return;
    S.lastCharacterStatus = key;
    opts.onCharacterStatus?.({ model: S.characterModel, contextUsedPercentage: sl.ctxPct, fresh });
  }
  function setCharacterActive(active: boolean): void {
    if (S.characterActive === active) return;
    S.characterActive = active;
    opts.onCharacterActivity?.(active);
  }
  /* The character runs while the turn is actually working. A card awaiting the user —
     an approval, or AskUserQuestion — is a wait, not work, and used to keep the run loop
     going for as long as the question sat there. Derived, not set: every
     writer of `pendingApproval` already calls refreshState(), which ends here, and
     setCharacterActive dedupes, so the extra calls cost nothing. `characterTurnOpen` is only
     ever set outside replay, which is what keeps a restored transcript from animating. */
  function syncCharacterActive(): void {
    if (S.hydrating) return;
    setCharacterActive(S.characterTurnOpen && !S.pendingApproval && S.isAlive);
  }
  const localCommand = createLocalCommand({ opts, noticeBlock, pickModelMenu, setModel, bar });

  /** encode* returns null when the adapter already sent the line itself */
  const sendEncoded = (line: string | null): Promise<boolean> => (line === null ? Promise.resolve(true) : send(line));

  const approvalQueue: string[] = [];
  /** approval cards that arrived before their pill (toolUseId → card) */
  const awaiting = new Map<string, HTMLElement>();
  /** Messages typed while a turn was running. submit() used to refuse outright,
   *  so anything that occurred to the user mid-turn had to be held in their head
   *  until the agent stopped. They are queued instead, drawn as dimmed pending
   *  blocks so they are visibly held rather than lost, and sent as one message on
   *  turn_done. Clicking a pending block takes the text back into the composer. */
  const queued: { text: string; host: HTMLElement }[] = [];

  bindStickScroll(transcript, S, follow, latest);
  function append(node: HTMLElement, parent: HTMLElement = transcript) {
    parent.appendChild(node);
    if (S.replaying) return;
    follow.toBottom();
    latest.update();
    opts.onActivity?.();
  }
  /** a resume replays the whole history: the transcript must be empty first
   *  (a Resume after death, or a Retry, would otherwise draw it twice) */
  function resetTranscript() {
    stream.reset(); // frames, text blocks, interim candidates
    tools.clear();
    awaiting.clear();
    clearAsyncAsks(); // its cards left with the transcript
    groups.reset(); // open and counted thoughts
    queued.length = 0;
    S.curGroup = null;
    S.turnGroups = [];
    transcript.textContent = "";
    transcript.appendChild(agentPill); // the pill survives a resume/clear clear: never a second one
    S.stick = true;
    sendStick.disarm(); // a send's echo the reset swallowed must not re-stick a later, unrelated echo
    clearWaiting(); bang.invalidate(); // hydration start, /clear, resume: a ! run in flight lands nowhere
    askMirror.redraw(); // Relay's tab cards were wiped with the transcript (drawn again unless hydrating)
  }

  /* -- activity groups, streamed text, tool pills --
     Built in dependency order, all before the cards (which take sealGroup, groupRefresh
     and stalePill as values). Values: `transcript`, `tools`, `awaiting` and every group,
     text and pill function passed below. Thunks: text-stream's `toolHost` (tool-pills is
     built after it) and tool-pills' `attachCard` (a cards output). */

  const hydrateStats = createHydrateStats(opts.tabId, transcript, () => S.hydrating);
  const groups = createGroups(S, { append, agent: opts.agent, stats: hydrateStats });
  const { groupFor, sealGroup, groupCount, groupRefresh, groupError, collapseTurnGroups, thinkingBlock, settleThoughts } = groups;
  const stream = createTextStream(S, { transcript, follow, append, sealGroup, toolHost: (p) => toolHost(p) });
  const { textDelta, textDone, markInterim, clearInterim, cancelFrames } = stream;
  const { toolHost, toolPending, toolStart, toolDone, stalePill } = createToolPills(S, {
    transcript, tools, awaiting, append, groupFor, groupCount, groupRefresh, groupError, markInterim, agent: opts.agent,
    attachCard: (toolUseId, card) => { attachCard(toolUseId, card); askMirror.sync(); }, // a card that beat its child pill
  });
  const bang = createBang(S, { enabled: AGENT_PROFILE[opts.agent].localCommands, hostOk: hostHas(opts.host, "bangMode"), sealGroup, toolStart, toolDone, noticeBlock,
    openPill: (id) => { const d = tools.get(id)?.details; if (d) { d.open = true; } } });

  /* -- blocks -- */

  function userBlock(text: string) {
    sealGroup();
    sendStick.onEcho();
    append(userBlockFor(text));
  }
  function noticeBlock(text: string, level: "info" | "warn" | "error", quiet?: boolean) {
    // quiet = bookkeeping (sidecar chatter, hooks, task events, slash expansions):
    // not drawn at all — it never carried an action for the user
    if (quiet) return;
    sealGroup();
    append(el("div", `blk blk-notice ${level}`, text));
  }
  // No status-line counter: the block itself is the record (rule: unknown events are
  // shown, never dropped). The old "Unknown N" chip toggled a `show-raw` class that no
  // stylesheet ever consumed, so it was a dead control.
  function unknownBlock(type: string, raw: string) {
    sealGroup();
    const d = el("details", "blk blk-unknown");
    d.append(el("summary", "", `Unrecognised event: ${type}`));
    d.append(el("pre", "", raw.length > OUTPUT_SHOW_MAX ? raw.slice(0, OUTPUT_SHOW_MAX) + "\n… (more)" : raw));
    append(d);
  }

  /* -- approvals -- */

  const { attachCard, openHydratedCards, approvalCard, asyncAskCard, settleAsyncAsks, clearAsyncAsks, openQuestions, cancelApprovals, denyPending, alreadyAnswered, TURN_ENDED } = createCards(S, {
    transport, textarea, follow, tools, approvals, approvalQueue, awaiting, sendEncoded,
    append, sealGroup, groupRefresh, stalePill, refreshState, noticeBlock, agent: opts.agent, stats: hydrateStats,
    sendText: (text) => sendText(text), // composer is built below; called only on a click
  });

  /* -- host payloads: built after the cards, so cancelApprovals and alreadyAnswered go in as values -- */

  const { hostPayload, nextHostedPrompt } = createHostPayload(S, {
    opts, transport, root, follow, textarea, approvals, cancelApprovals, alreadyAnswered,
    resetTranscript, resetCache, setInTurn, append, sealGroup, noticeBlock, refreshState, emitCharacterStatus,
    interrupt: () => interrupt(), // composer is built below; called only on a click
    stats: hydrateStats, openHydratedCards, tools, stalePill, bang,
  });

  /* -- composer -- */

  const { updatePalette, movePalette, pickPalette, hidePalette } = createPalette(S, { palette, textarea });
  const { submit, sendText, flushQueue, markUndelivered, interrupt, queuedHosts } = createComposer(S, {
    transport, textarea, palette, sl, queued, approvals, sendEncoded, localCommand, denyPending,
    stopAgent: (detach) => stopAgent(detach), spawn: () => spawn(), // thunks: lifecycle is built last
    resetTranscript, setInTurn, sealGroup, append, userBlock, noticeBlock,
    updatePalette, movePalette, pickPalette, hidePalette, bang, sendStick,
  });

  /* -- events -- */

  // onExit is a thunk: lifecycle is built last
  const login = createLogin(S, {
    claude: AGENT_PROFILE[opts.agent].loginCheck,
    tip: AGENT_PROFILE[opts.agent].loginTip,
    check: authCheck(AGENT_PROFILE[opts.agent].loginCheck, hostHas(opts.host, "loginCheck"), claudeStatus(transport)),
    noticeBlock, redrawStatus, refreshState, reach: () => bar.login?.reach?.() ?? "card",
  });
  const { handle } = createEvents(S, {
    login, loginUrl: (url) => bar.login?.url?.(url), opts, transport, sl, follow, textarea, tools, approvals, waiting, TURN_ENDED,
    modeLabel, updatePalette, renderAgentPill, redrawStatus, refreshState, emitCharacterStatus, setInTurn, updateCtx,
    markCacheWarm, resetCache, settleModel, settleSwitch, append, userBlock, unknownBlock, noticeBlock: (t, l, q) => { if (!(l === "error" && bar.login?.fail?.(t))) noticeBlock(t, l, q); }, // a login failure shows once, in the open login card
    restoredBlock: (t, truncated) => { sealGroup(); append(restoredCard(t, truncated)); },
    textDelta, textDone, thinkingBlock, settleThoughts, sealGroup, clearInterim, collapseTurnGroups,
    toolPending, toolStart, toolDone, stalePill, approvalCard, alreadyAnswered, asyncAskCard, settleAsyncAsks,
    addWaiting, resumeWaiting, taskDone, liveTasks, clearWaiting, settleDoneAgents, settleReplayedAgents, flushQueue, onExit: (code) => onExit(code), groupRefresh,
    pendingQueued: () => [...queuedHosts(), ...nextHostedPrompt()], // a hosted body never fills the composer queue
  });
  function updateCtx(u: Usage) {
    // the last API call's context: fresh input + everything read/written to cache
    sl.ctxTokens = u.inputTokens + u.cacheRead + u.cacheCreate;
    sl.ctxPct = sl.contextWindow ? Math.min(100, Math.round((sl.ctxTokens / sl.contextWindow) * 100)) : null;
  }
  function setInTurn(on: boolean) {
    if (on) S.interruptSent = false; // a fresh turn has not been interrupted yet
    S.inTurn = on;
    root.classList.toggle("in-turn", on);
    if (!on && S.turnEndWaiters.length) {
      const waiters = S.turnEndWaiters;
      S.turnEndWaiters = [];
      for (const settle of waiters) settle();
    }
    refreshState();
    drawCache();
  }
  /** the one status the composer shows (rendered/state-chip.ts); called from every signal change */
  function refreshState() {
    const chip = chipState(S, sl.model === "Starting…", agents.runningCount());
    stateChip.title = chip.title;
    stateChip.dataset.state = chip.cls;
    opts.onTabState?.(chip, (S.pendingApproval && approvals.get(S.pendingApproval)?.dataset.tool) || null, S.hydrating);
    bar.syncControls(); // mode, model and effort segments
    syncCharacterActive();
    askMirror.sync(); // a subagent's pending approval as a Relay card
  }

  /* -- backend: built last; composer, events and the status bar reach it through thunks -- */

  const { send, spawn, stopAgent, onExit, respawnFresh } = createLifecycle(S, {
    opts, transport, root, sl, queued, tools, newAdapter, handle: (ev) => { hydrateStats.record(); handle(ev); }, hostPayload, markUndelivered,
    cancelApprovals, denyPending, alreadyAnswered, stalePill, sealGroup, settleThoughts, clearWaiting, settleSwitch,
    resetCache, stopCacheTimer, drawCache, redrawStatus, resetTranscript, setInTurn, refreshState,
    append, noticeBlock, sendEncoded, stats: hydrateStats, openHydratedCards, checkLogin: login.check,
  });

  // a transcript click hands focus back to the composer without the border flashing
  wireTranscriptFocus(transcript, textarea);

  /* -- public -- */

  // `S.spawning` clears only after transport.spawn resolved and `S.gen` was set.
  const promptReady = (): boolean =>
    S.isAlive && !S.spawning && !S.hydrating && !S.disconnected && !S.disposed;

  const body: RenderedBody = {
    el: root,
    focus: () => textarea.focus(),
    async write(data: string) {
      if (!S.isAlive) return false;
      const submitNow = data.endsWith("\r");
      const text = (submitNow ? data.slice(0, -1) : data).replace(/\r\n?/g, "\n");
      // the Model select types "/model <x>": a TUI command headless Claude can't act on, so the real setter
      if (submitNow && localCommand(text.trim())) return true;
      const held = submitNow && !promptReady(); // not ready: the text lands unsent (visible) and write says false
      if (text) {
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? start;
        textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
        const caret = start + text.length;
        textarea.setSelectionRange(caret, caret);
        updatePalette();
      }
      if (!submitNow || held) bang.written(textarea.value); // submit() gives a \r line its own notice
      return held ? false : submitNow ? submit() : true; // submit() is false for blank text too
    },
    alive: () => S.isAlive,
    hosted: () => !!transport.durable,
    sessionId: () => S.sessionId,
    draft: () => textarea.value,
    isBusy: () => S.inTurn || S.hydrating,
    queuedCount: () => queued.length,
    promptReady: () => promptReady(),
    async sendPrompt(text: string) {
      // In-process (Codex) tabs echo the user block from the composer, not the host,
      // so only a durable transport gets a composer-less prompt.
      if (!transport.durable) throw new Error("not a hosted tab");
      if (!promptReady()) throw new Error("tab not ready");
      const line = S.adapter.encodeUser(text);
      if (line === null) throw new Error("cannot encode");
      await transport.send(opts.tabId, S.gen, line);
    },
    permissionMode: () => S.mode,
    async shutdown() {
      if (S.disposed) return;
      await stopAgent();
    },
    async detach() {
      if (S.disposed) return;
      await stopAgent(true);
    },
    respawnFresh: () => respawnFresh(),
    disconnected: () => S.disconnected,
    async abandon() {
      const g = S.gen;
      const tell = (async () => {
        try {
          await transport.kill(opts.tabId, g); // a success also drops the host-side view entry
          return;
        } catch (e) {
          console.warn(`hosted close: falcon did not close tab ${opts.tabId}: ${String(e)}`);
        }
        try {
          await transport.detach?.(opts.tabId, g); // local entry only; the lease died with the pipe
        } catch (e) {
          console.warn(`hosted close: local detach of tab ${opts.tabId} failed: ${String(e)}`);
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, ABANDON_BOUND_MS); });
      await Promise.race([tell, bound]);
      clearTimeout(timer);
    },
    drive: () => {
      const allCards = [...transcript.querySelectorAll<HTMLElement>(`.${DRIVE_CLASS.card}:not(.${API_KEY_CARD})`)];
      const pending = allCards.filter((card) => !card.classList.contains(DRIVE_CLASS.settled));
      return {
        model: sl.model,
        mode: sl.mode,
        state: stateChip.dataset.state ?? "",
        stateText: stateChip.title.split("\n")[0] ?? "",
        modeBlocked: modeBtnBlocked(),
        cards: cardsSnapshot(pending.map((card) => ({
          requestId: card.dataset.requestId,
          tool: card.dataset.tool,
          questions: [...card.querySelectorAll(`.${DRIVE_CLASS.question}`)].map((q) =>
            [...q.querySelectorAll(`.${DRIVE_CLASS.option}`)].map((b) => (b as HTMLElement).dataset.label ?? b.textContent)),
          result: card.querySelector(`.${DRIVE_CLASS.result}`)?.textContent ?? null,
        }))),
        settledCards: allCards.length - pending.length,
      };
    },
    dispose() {
      S.characterTurnOpen = false;
      setCharacterActive(false);
      S.disposed = true;
      stopCacheTimer();
      agents.dispose();
      askMirror.dispose(); // the tab's Relay cards leave with it
      closeStMenu(); bar.closeCabinet(); bar.login?.dispose?.(); // ends a running Claude login
      releaseAdapterRoute(opts.tabId, S.adapter);
      cancelFrames();
      follow.dispose();
      root.remove();
    },
  };

  void ensureListeners().then(() => { if (!S.disposed) void spawn(); });
  return body;
}
