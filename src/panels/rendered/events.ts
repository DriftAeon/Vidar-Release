// Event handler of a Rendered body: `handle(ev)` turns each protocol.ts AgentEvent
// into transcript blocks, status-line values and state changes.

import { invoke } from "../../ipc";
import type { AgentEvent, Effort, PermissionMode, PlanView, Usage } from "../../agents/protocol";
import { EFFORT_LEVELS, isPermissionMode } from "../../agents/protocol";
import { getPref, setPref } from "../../prefs";
import { codexModelsPref } from "../../agents/codex-settings";
import { hostHas } from "./host-profile";
import { AGENT_PROFILE } from "./agent-profile";
import { titleCase, prettyModel } from "../../format";
import type { AgentTransport } from "./transport";
import { turnSubtype } from "./format";
import { el } from "./dom";
import { iconImg } from "../../icon-img";
import { markSteered, steeredTurn } from "./queued-block";
import type { RenderedOpts } from "./opts";
import { createMonitorRun } from "./monitor-run";
import type { Group, RenderedState, StatusLine, ToolRecord, WaitingRow } from "./state";
import type { Follow } from "./follow";

/** `claude --version` once per app run (src-tauri claude_version.rs caches too);
 *  null when claude is missing, so the bundle chip simply never shows. */
let installedClaude: Promise<string | null> | null = null;
function installedClaudeVersion(): Promise<string | null> {
  installedClaude ??= invoke("claude_installed_version").catch(() => null);
  return installedClaude;
}

/* Slash commands the TUI answers locally. Claude Code reports them in
   terminal_slash_commands, which the palette otherwise filters out; these
   stay because a rendered body answers them itself (localCommand). */
const LOCAL_COMMANDS = new Set(["/model", "/effort", "/resume", "/clear"]);

/** What the handler closes over in createRenderedBody. */
export interface EventsDeps {
  /** rendered/login.ts: a live turn's reply can say the CLI is not logged in */
  login: { sawTurn: (resultText: string, clean: boolean) => void; fromAgent: (loggedIn: boolean) => void };
  /** the open login card offers a ChatGPT login link as Copy Link (api-key-card.ts) */
  loginUrl?: (url: string) => void;
  opts: RenderedOpts;
  transport: AgentTransport;
  sl: StatusLine;
  follow: Follow;
  textarea: HTMLTextAreaElement;
  tools: Map<string, ToolRecord>;
  approvals: Map<string, HTMLElement>;
  waiting: Map<string, WaitingRow>;
  TURN_ENDED: string;
  modeLabel: (m: string) => string;
  updatePalette: () => void;
  renderAgentPill: (cwd?: string) => void;
  redrawStatus: () => void;
  refreshState: () => void;
  emitCharacterStatus: (fresh: boolean) => void;
  setInTurn: (on: boolean) => void;
  updateCtx: (u: Usage) => void;
  markCacheWarm: () => void;
  resetCache: () => void;
  settleModel: (confirmed: string | null) => void;
  settleSwitch: (confirmed: PermissionMode | null) => void;
  append: (node: HTMLElement, parent?: HTMLElement) => void;
  userBlock: (text: string) => void;
  noticeBlock: (text: string, level: "info" | "warn" | "error", quiet?: boolean) => void;
  /** the history-replay card: clock and "2 Turns"; a tooltip says when older history was cut */
  restoredBlock: (text: string, truncated: boolean) => void;
  unknownBlock: (type: string, raw: string) => void;
  textDelta: (blockId: string, text: string) => void;
  textDone: (blockId: string, markdown: string, parent: string | null, plan?: PlanView) => void;
  thinkingBlock: (blockId: string, done: boolean) => void;
  settleThoughts: () => void;
  sealGroup: () => void;
  clearInterim: () => void;
  collapseTurnGroups: () => void;
  toolPending: (toolUseId: string, name: string, parent: string | null) => void;
  toolStart: (toolUseId: string, name: string, input: unknown, truncated: number | undefined, parent: string | null) => void;
  toolDone: (toolUseId: string, content: string, isError: boolean, structured: unknown, truncated: number | undefined, parent: string | null) => void;
  stalePill: (t: { details: HTMLDetailsElement; group: Group | null }) => void;
  approvalCard: (requestId: string, toolUseId: string | undefined, tool: string, input: unknown, inputBytes: number, _suggestions: unknown[]) => void;
  alreadyAnswered: (text: string) => boolean;
  /** cards.ts: a Codex async ask as the Question card, and the fold a later user message gives it */
  asyncAskCard?: (id: string, questions: { title: string; options: string[] }[]) => void;
  settleAsyncAsks?: () => void;
  addWaiting: (taskId: string, toolUseId: string | undefined) => void;
  resumeWaiting: (taskId: string, toolUseId: string | undefined) => void;
  taskDone: (taskId: string, status?: string, summary?: string, report?: string, tokens?: number, fromUpdate?: boolean) => void;
  liveTasks: (taskIds: readonly string[], subagentOwned: readonly string[], owners?: Readonly<Record<string, string>>) => void;
  clearWaiting: () => void;
  settleDoneAgents: () => void;
  settleReplayedAgents: () => void;
  flushQueue: () => void;
  /** the queued blocks this turn's end sends next (composer queue, or the host's oldest waiting prompt) */
  pendingQueued: () => HTMLElement[];
  onExit: (code: number | null) => void;
  groupRefresh: (g: Group) => void;
}

/** the last Claude tab's model list (the `models` case below saves it), so a new tab's picker
 *  works before its own initialize handshake. Codex's picker uses its own session-only catalog;
 *  the saved `codexModels` copy feeds Settings › Agents only. */
export function seededModels(agent: string): RenderedState["models"] {
  return agent === "claude" ? getPref("claudeModels") ?? [] : [];
}

export function createEvents(S: RenderedState, deps: EventsDeps) {
  const {
    login, loginUrl, opts, transport, sl, follow, textarea, tools, approvals, TURN_ENDED,
    modeLabel, renderAgentPill, redrawStatus, refreshState, emitCharacterStatus, setInTurn, updateCtx,
    markCacheWarm, resetCache, settleModel, settleSwitch, append, userBlock, noticeBlock, restoredBlock, unknownBlock,
    textDelta, textDone, thinkingBlock, settleThoughts, sealGroup, clearInterim, collapseTurnGroups,
    toolPending, toolStart, toolDone, stalePill, approvalCard, alreadyAnswered, asyncAskCard, settleAsyncAsks,
    addWaiting, resumeWaiting, taskDone, liveTasks, clearWaiting, settleDoneAgents, settleReplayedAgents, flushQueue, pendingQueued, onExit, groupRefresh,
  } = deps;
  const monitors = createMonitorRun(S, { tools, groupRefresh });
  /** The ChatGPT login's one notice: a new link replaces it and a login clears it, so repeated
   *  opens do not stack and none outlives the login. */
  let loginNote: HTMLElement | null = null;
  function loginNotice(text: string, level: "info" | "error", reason?: string) {
    loginNote?.remove();
    sealGroup();
    loginNote = el("div", `blk blk-notice ${level}`, text);
    if (reason) loginNote.title = reason;
    append(loginNote);
  }
  /** Only fills a blank: an explicit launcher model or a confirmed init wins. */
  function hintModel(model: string) {
    if (sl.model !== "Starting…" && sl.model !== "Ready") return;
    sl.model = prettyModel(model);
    S.modelHinted = true;
    if (!S.characterModelLive) S.characterModel = model;
    redrawStatus();
    // the right panel's Model select reads the tab's model off the focus event
    opts.onSession?.({ sessionId: S.sessionId ?? "", model, cwd: opts.cwd, permissionMode: S.mode });
    emitCharacterStatus(false);
  }
  /** Before the first reply the pill shows the spawn alias ("Opus", "Opus 1M"); the catalog row
   *  for that alias says which version it covers, so the pill names it as a hint. `system/init`
   *  stays the live truth (it sets characterModelLive and overwrites this). */
  function versionAlias(models: { value: string; resolved?: string }[]) {
    const alias = opts.model;
    if (opts.agent !== "claude" || !alias || S.characterModelLive || sl.model !== prettyModel(alias)) return;
    const resolved = models.find((m) => m.value === alias)?.resolved;
    if (!resolved) return;
    const versioned = /\[1m\]$/i.test(alias) && !/\[1m\]$/i.test(resolved) ? `${resolved}[1m]` : resolved;
    const name = prettyModel(versioned);
    if (name === sl.model) return;
    sl.model = name;
    S.modelHinted = true;
    S.characterModel = versioned;
    opts.onSession?.({ sessionId: S.sessionId ?? "", model: versioned, cwd: opts.cwd, permissionMode: S.mode });
    emitCharacterStatus(false);
  }
  function handle(ev: AgentEvent) {
    switch (ev.kind) {
      case "commands":
        S.commands = ev.commands;
        deps.updatePalette();
        break;
      case "session":
        if (ev.sessionId && S.sessionId && ev.sessionId !== S.sessionId) { clearWaiting(); monitors.endAll(); } // a new session: the old agents and monitors are gone with it
        S.sessionId = ev.sessionId || S.sessionId;
        refreshState(); // sessionId feeds the state chip tooltip
        // terminal-only commands are dropped from the palette — except the ones
        // this body answers itself (see localCommand), which do work when typed.
        S.commands = ev.commands.filter((c) => !ev.terminalCommands.includes(c) || LOCAL_COMMANDS.has(c));
        sl.model = ev.model ? prettyModel(ev.model) : "?";
        if (ev.model) { S.characterModel = ev.model; S.characterModelLive = true; }
        S.pickedModel = null; // init reports the CLI's own model; an earlier pick no longer applies
        S.modelHinted = false; // init is the CLI's word
        if (isPermissionMode(ev.permissionMode)) {
          S.mode = ev.permissionMode; // init/resume truth
        }
        if (!S.switchPending) sl.mode = modeLabel(ev.permissionMode || S.mode);
        if (ev.cwd) sl.dir = titleCase(ev.cwd.split(/[\\/]/).filter(Boolean).pop() ?? sl.dir);
        S.pillVersion = ev.version;
        if (ev.model) S.pillModel = ev.model;
        renderAgentPill(ev.cwd || opts.cwd);
        if (transport.durable && hostHas(opts.host, "installedVersionCheck") && ev.version && S.pillInstalled === null) {
          void installedClaudeVersion().then((v) => {
            if (!v || S.disposed) return;
            S.pillInstalled = v;
            renderAgentPill();
          });
        }
        redrawStatus();
        opts.onSession?.({ sessionId: ev.sessionId, model: ev.model, cwd: ev.cwd, permissionMode: ev.permissionMode });
        emitCharacterStatus(true);
        break;
      case "turn_start":
        settleAsyncAsks?.(); // a new turn follows a user message: an open async ask before it is answered
        if (!S.replaying) S.characterTurnOpen = true;
        setInTurn(true); // refreshState → syncCharacterActive
        break;
      case "user_echo":
        settleAsyncAsks?.();
        userBlock(ev.text);
        break;
      case "replay":
        if (ev.phase === "start") {
          S.replaying = true;
          if (ev.truncated) noticeBlock(`Older history not shown (${ev.truncated} earlier messages)`, "info");
        } else {
          S.replaying = S.hydrating;
          // a tool whose result never arrived is not running: the session ended mid-call
          // the history replay precedes any live turn, so every open pill here is history
          for (const t of tools.values()) {
            const c = t.details.classList;
            if (c.contains("running") || c.contains("pending") || c.contains("awaiting")) stalePill(t);
          }
          settleReplayedAgents(); // a replayed launch has no hand-back in history and the new process owns no agent
          for (const g of S.turnGroups) g.details.open = false;
          sealGroup();
          S.turnGroups = [];
          const noun = AGENT_PROFILE[opts.agent].resumeNoun; // both profile nouns pluralise with "s"
          const word = titleCase(ev.count === 1 ? noun.replace(/s$/, "") : noun);
          restoredBlock(`${ev.count} ${word}`, !!ev.truncated);
          follow.jump(); // a replayed history lands at the end, no glide
          S.stick = true;
        }
        break;
      case "text_delta": textDelta(ev.blockId, ev.text); break;
      case "text_done": textDone(ev.blockId, ev.markdown, ev.parentToolUseId, ev.plan); break;
      case "thinking": thinkingBlock(ev.blockId, ev.done); break;
      case "tool_pending": toolPending(ev.toolUseId, ev.name, ev.parentToolUseId); break;
      case "tool_start":
        toolStart(ev.toolUseId, ev.name, ev.input, ev.inputTruncated, ev.parentToolUseId);
        monitors.onToolStart(ev.toolUseId, ev.name, ev.input);
        if (!S.replaying) opts.onToolStart?.(ev.toolUseId, ev.name, ev.input, ev.parentToolUseId);
        break;
      case "tool_done":
        toolDone(ev.toolUseId, ev.content, ev.isError, ev.structured, ev.truncated, ev.parentToolUseId);
        monitors.onToolDone(ev.toolUseId, ev.content, ev.isError);
        opts.onToolDone?.(ev.toolUseId, ev.isError);
        break;
      case "ask_async": asyncAskCard?.(ev.blockId, ev.questions); break;
      case "approval": approvalCard(ev.requestId, ev.toolUseId, ev.tool, ev.input, ev.inputBytes, ev.suggestions); break;
      case "turn_done": {
        const authoritativeCharacterTurn = S.characterTurnOpen && !S.replaying;
        S.characterTurnOpen = false;
        setInTurn(false); // refreshState → syncCharacterActive; unconditional is safe
                          // because characterTurnOpen is only ever set outside replay
        settleThoughts();
        // a turn that ended (interrupt included) left no top-level call in flight: an open
        // ask/approval card in its pill is over (settled silently, the CLI has moved on) and
        // the pill goes stale, or its group pulses forever. Group-less pills are subagent
        // children, which a background agent can still be running after the turn ends.
        if (!S.replaying) {
          for (const t of tools.values()) {
            const c = t.details.classList;
            if (!t.group || !(c.contains("running") || c.contains("pending") || c.contains("awaiting"))) continue;
            (t.card as (HTMLElement & { settle?: (d: { behavior: "deny"; message?: string }, silent?: boolean) => void }) | null)
              ?.settle?.({ behavior: "deny", message: TURN_ENDED }, true);
            stalePill(t);
          }
        }
        sealGroup();
        clearInterim();
        collapseTurnGroups();
        settleDoneAgents(); // refreshes the block; done rows stay until cleared (Clear Done or a row's x), running ones keep ticking
        if (ev.costUsd !== null) { S.costTotal += ev.costUsd; refreshState(); } // costTotal feeds the tooltip
        if (ev.contextWindow) sl.contextWindow = ev.contextWindow;
        if (ev.usage) updateCtx(ev.usage);
        // a turn that read or wrote cache just re-warmed the prefix; one that errored
        // before any API call carries no usage and leaves the previous stamp alone
        if (ev.usage && ev.usage.cacheRead + ev.usage.cacheCreate > 0) markCacheWarm();
        emitCharacterStatus(true);
        if (!S.replaying) login.sawTurn(ev.resultText, ev.subtype === "success" && !ev.isError);
        redrawStatus();
        // footer only when it says something: a clean turn's tokens and
        // turn count were noise; a failure, denial or odd subtype still gets its line
        const parts: string[] = [];
        // queued prompts cut this turn short (Steer, or an interrupt with prompts waiting): they
        // carry the steer marker instead of a footer. Read from the transcript, so a replay
        // (the turn's result precedes the prompt's `prompt-dispatched`) draws it the same.
        const pending = ev.subtype === "error_during_execution" || ev.subtype === "interrupted" ? pendingQueued() : [];
        const steered = steeredTurn(ev.subtype, pending.length);
        if (steered) for (const host of pending) markSteered(host);
        if (!steered && ev.subtype !== "success") {
          const label = turnSubtype(ev.subtype, S.interruptSent);
          // a user stop (Claude's error_during_execution after Esc, Codex's interrupted) is a chip, not footer text
          if (label === "Interrupted") {
            const chip = el("div", "blk blk-turn-chip");
            chip.append(iconImg("cancel"), el("span", "", label));
            append(chip);
          } else parts.push(label);
        }
        if (!steered && (parts.length || ev.isError)) {
          const foot = el("div", `blk blk-turn${ev.isError ? " error" : ""}`, parts.join(" · "));
          if (ev.isError && ev.resultText) foot.append(el("div", "turn-error", ev.resultText.slice(0, 2000)));
          append(foot);
        }
        if (authoritativeCharacterTurn && ev.subtype === "success" && !ev.isError && ev.denials.length === 0) {
          opts.onCharacterCompletion?.();
        }
        flushQueue(); // last, so the queued message lands after this turn's footer
        if (!S.replaying) opts.onReplyDone?.();
        break;
      }
      case "models": {
        S.models = ev.models;
        if (opts.agent === "claude" && ev.models.length) {
          const next = ev.models.map((m) => ({ value: m.value, label: m.label, resolved: m.resolved }));
          if (JSON.stringify(getPref("claudeModels")) !== JSON.stringify(next)) setPref("claudeModels", next);
        } else if (opts.agent === "codex" && ev.models.length && !ev.partial) {
          // Settings › Agents reads it; the tab's own picker stays session-only
          const next = codexModelsPref(ev.models);
          if (JSON.stringify(getPref("codexModels")) !== JSON.stringify(next)) setPref("codexModels", next);
        }
        // no settings hint left the pill on "Ready" while the picker ticks the row Default
        // resolves to: show that model, as a hint (first-run smoke 2026-10-08, finding 7)
        const byDefault = sl.model === "Ready" ? ev.models.find((m) => m.value === "default")?.resolved : undefined;
        if (byDefault) hintModel(byDefault);
        else versionAlias(ev.models);
        redrawStatus();
        break;
      }
      case "cache_ttl":
        S.cacheTtlMs = ev.ttlMs;
        resetCache(); // the switch that told us this also forfeited the cache
        break;
      case "model_set":
        if (ev.model === null) {
          settleModel(null);
          noticeBlock(`Model change failed: ${ev.error ?? "unknown"}`, "error");
        } else {
          settleModel(ev.model);
        }
        break;
      case "model_hint":
        hintModel(ev.model);
        break;
      case "mode":
        if (ev.mode === null) {
          settleSwitch(null);
          noticeBlock(`Mode change failed: ${ev.error ?? "unknown"}`, "error");
        } else if (ev.ack || !S.switchPending) {
          settleSwitch(ev.mode);
        }
        break;
      case "notice":
        // Claude Code emits its init only when the first turn starts; until then
        // the sidecar's ready line is the honest state
        if (ev.text === "Sidecar ready" && sl.model === "Starting…") { sl.model = "Ready"; redrawStatus(); }
        if (ev.level === "error" && alreadyAnswered(ev.text)) break;
        noticeBlock(ev.text, ev.level, ev.quiet);
        break;
      case "effort":
        if (ev.level !== sl.effort) { sl.effort = ev.level; redrawStatus(); }
        if ((EFFORT_LEVELS as readonly string[]).includes(ev.level)) S.liveEffort = ev.level as Effort;
        // seed a body with no chosen effort so a /clear respawn keeps the running level
        // a replayed Codex level (the host's applied pick) is the tab's choice too
        if ((opts.effort === null || (S.hydrating && opts.agent === "codex")) && (EFFORT_LEVELS as readonly string[]).includes(ev.level)) opts.effort = ev.level as Effort;
        break;
      case "rate_limit":
        if (ev.utilization !== null) {
          sl.limits.set(ev.window, { pct: ev.utilization, resetsAt: ev.resetsAt });
          redrawStatus();
        }
        if (ev.status === "rejected") noticeBlock(`Rate limit reached (${ev.window})`, "warn");
        break;
      case "exit": monitors.endAll(); onExit(ev.code); break;
      case "send_failed":
        setInTurn(false);
        noticeBlock(`Not sent: ${ev.reason}`, "error");
        // give the draft back rather than losing it
        if (!textarea.value.trim()) textarea.value = ev.text;
        else textarea.value = `${ev.text}\n${textarea.value}`;
        break;
      case "approval_done": {
        const card = approvals.get(ev.requestId) as (HTMLElement & { settle?: (d: { behavior: "deny"; message?: string }, silent?: boolean) => void }) | undefined;
        card?.settle?.({ behavior: "deny", message: ev.reason }, true);
        break;
      }
      case "task":
        if (ev.phase === "launched") addWaiting(ev.taskId, ev.toolUseId);
        else if (ev.phase === "resumed") resumeWaiting(ev.taskId, ev.toolUseId);
        else {
          taskDone(ev.taskId, ev.status, ev.summary, ev.report, ev.tokens, ev.fromUpdate);
          // a monitor or background shell ends on its notification's status; a terminal task_updated
          // (failed/killed) also ends one, since a killed shell may send nothing else
          monitors.onTaskDone(ev);
        }
        break;
      case "tasks_live":
        // the SDK's own live-membership signal: absence closes a row unless the agent may be parked
        // on background tasks it started (agents-block.ts liveTasks); the typed done notice that
        // usually follows fills status/summary, removeWaiting is idempotent for that
        liveTasks(ev.taskIds, ev.subagentOwned ?? [], ev.subagentOwners);
        monitors.onTasksLive(ev.taskIds);
        break;
      case "auth":
        if (ev.loggedIn) { loginNote?.remove(); loginNote = null; }
        login.fromAgent(ev.loggedIn);
        break;
      case "login_url":
        // the card keeps the link: open_url drops ShellExecuteW's result, so a browser that never opened is silent
        loginUrl?.(ev.url);
        // the adapter passes only https://auth.openai.com/ links; open_url checks the scheme again
        void invoke("open_url", { url: ev.url }).then(
          // open_url returns before the shell runs, so the notice never claims the page opened
          () => loginNotice("Opening ChatGPT Login", "info"),
          // the raw reason rides in the tooltip
          (e) => loginNotice("ChatGPT Login Did Not Open", "error", String(e)),
        );
        break;
      case "unknown": unknownBlock(ev.type, ev.raw); break;
    }
  }

  return { handle };
}
