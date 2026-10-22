// Background-agents block of a Rendered body: a process table above the status line for Agent
// tools still running (summary with counts, one row per agent, a drawer under the rows), their
// elapsed-time timer, and settling or clearing them. An open row expands in place: the drawer body
// is moved to sit right under it.

import { el, btn } from "./dom";
import { iconImg } from "../../icon-img";
import { getPref, setPref } from "../../prefs";
import { createDismissedStore } from "./agents-dismissed";
import { markSlot, type Mark } from "./marks";
import { fmtTokens } from "./format";
import { AGENT_WORD, agentState, awaitingPill, createAgentsDrawer, fillCalls, reportVerdict, setHidden, setSlotMark, setState, setText, stateMark, type AgentState } from "./agents-drawer";
import type { RenderedState, ToolRecord, WaitingRow } from "./state";

/** What the agents block closes over in createRenderedBody. */
export interface AgentsBlockDeps {
  tools: Map<string, ToolRecord>;
  noticeBlock: (text: string, level: "info" | "warn" | "error", quiet?: boolean) => void;
  refreshState: () => void;
  /** the transcript scroller, kept pinned to the bottom across drawer open/close */
  transcript?: HTMLElement;
}

/** How long a drained park waits for the CLI's wake or next live set before it settles (C4).
 *  A wake follows the child's end within seconds (the 2026-10-16 probe); inferred, not measured. */
export const DRAIN_SETTLE_MS = 30_000;

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  const mm = m % 60, ss = s % 60;
  return h > 0 ? `${h}:${String(mm).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

const CHIP_ORDER: AgentState[] = ["running", "needs", "done", "failed"];

/** An open child view, as data: what the tab strip's subtabs paint from (sessions/tab-agents.ts). */
export interface AgentSummary { id: string; label: string; title: string; state: AgentState; selected: boolean; closed: boolean }
/** `agents` null: the block was disposed (its body left the tab). */
type AgentsListener = (host: HTMLElement, agents: readonly AgentSummary[] | null) => void;
const agentsListeners = new Set<AgentsListener>();
const liveBlocks = new Map<HTMLElement, { list: readonly AgentSummary[]; open: (taskId: string) => boolean; close: (taskId: string) => boolean }>();

/** Every block's summary on each change; a new subscriber first gets every live block's current list. */
export function subscribeAgents(fn: AgentsListener): () => void {
  agentsListeners.add(fn);
  for (const [host, b] of liveBlocks) fn(host, b.list);
  return () => { agentsListeners.delete(fn); };
}
function emitAgents(host: HTMLElement, list: readonly AgentSummary[] | null) {
  for (const fn of [...agentsListeners]) fn(host, list);
}
/** Expand the block's list and open (never toggle shut) one row's drawer; false when the block or row is gone. */
export function openAgentRow(host: HTMLElement, taskId: string): boolean {
  return liveBlocks.get(host)?.open(taskId) ?? false;
}
/** Close a child view; running work remains tracked in the parent's table. */
export function closeAgentTab(host: HTMLElement, taskId: string): boolean {
  return liveBlocks.get(host)?.close(taskId) ?? false;
}

export function createAgentsBlock(S: RenderedState, deps: AgentsBlockDeps) {
  const { tools, noticeBlock, refreshState } = deps;
  // a background Agent tool left running past turn end: the transcript alone
  // reads idle, so a process table says which, for how long, and how it
  // landed — sits above the status line so it never scrolls with the transcript.
  const agentsBlock = el("div", "rendered-agents");
  agentsBlock.hidden = true;

  const head = el("div", "agents-head");
  const toggle = el("button", "agents-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "true");
  const chips = el("span", "agents-chips");
  const agentsIcon = iconImg("agent");
  agentsIcon.title = "Agents";
  // no chevron: the whole bar is the toggle, an arrow repeats it (2026-10-05)
  toggle.append(agentsIcon, el("span", "agents-title", "Agents"), chips);
  // icon-only (2026-10-05): only finished rows go; the label lives in aria-label and the tooltip
  const clearDone = btn("", "agent-btn agents-clear-done", () => clearDoneRows());
  clearDone.append(iconImg("edit-clear"));
  clearDone.title = "Clear";
  clearDone.setAttribute("aria-label", "Clear");
  head.append(toggle, clearDone);

  const agentsRows = el("div", "rendered-agents-rows");
  const rowsWrap = el("div", "rendered-agents-wrap");
  rowsWrap.dataset.open = "true";
  rowsWrap.append(agentsRows);
  const drawer = createAgentsDrawer({ tools });
  agentsBlock.append(head, rowsWrap, drawer.el);
  const dismissed = createDismissedStore({
    get: () => getPref("rendered.dismissedAgents"),
    set: (m) => { setPref("rendered.dismissedAgents", m); },
  });
  liveBlocks.set(agentsBlock, { list: [], open: openRow, close: closeTab });

  function setListOpen(open: boolean) {
    toggle.setAttribute("aria-expanded", String(open));
    rowsWrap.dataset.open = String(open);
    if (!open) closeDrawer();
  }
  toggle.addEventListener("click", () => {
    setListOpen(toggle.getAttribute("aria-expanded") !== "true");
    publishAgents();
  });

  /* -- background agents, this turn --
     Launch is the Agent tool's own result text (claude.ts `user()`); the
     completion side used to be only a `<task-notification>` block that may never
     arrive on the Node SDK (see protocol.ts task event, claude.ts
     parseTaskNotification) — the hand-back string claude.ts now also recognises
     is the guaranteed signal. Finished rows leave through Clear or a subtab's X, or a session reset;
     the table itself has no per-row X or drawer Dismiss (2026-10-05: bloat). */
  const waiting = new Map<string, WaitingRow>();
  const closedTabs = new Set<string>(); // view-only while live; the table still owns lifecycle

  function drawRow(w: WaitingRow) {
    const t = w.toolUseId ? tools.get(w.toolUseId) : undefined;
    w.needs = !w.done && !!awaitingPill(t);
    const s = agentState(w);
    const mark: Mark = stateMark(s);
    setSlotMark(w.marker, mark);
    setText(w.word, AGENT_WORD[s]);
    setState(w.row, s);
    setState(w.bar, s);
    fillCalls(w.calls, t);
    setText(w.time, w.elapsedFrozen ?? fmtElapsed(Date.now() - w.since));
    const open = w.row.getAttribute("aria-expanded") === "true";
    setText(w.tokensCell, w.tokens ? fmtTokens(w.tokens).toUpperCase() : "");
    setHidden(w.tokensCell, !open || !w.done || !w.tokens);
    setHidden(w.showBtn, !open);
    // a report in hand: the desc slot carries its verdict, the description stays in the drawer head
    const verdict = w.report ? reportVerdict(w.report) : "";
    if (verdict && w.desc) {
      if (!w.desc.isConnected) w.row.querySelector(".agent-name")?.append(" ", w.desc);
      if (w.desc.textContent !== verdict) { w.desc.textContent = verdict; }
      if (w.desc.title !== verdict) w.desc.title = verdict;
    }
  }
  let chipSig = "";
  function drawChips() {
    const n: Record<AgentState, number> = { running: 0, needs: 0, done: 0, failed: 0 };
    for (const w of waiting.values()) n[agentState(w)]++;
    const multi = waiting.size > 1;
    const sig = `${multi}|${CHIP_ORDER.map((k) => n[k]).join(",")}`;
    if (sig !== chipSig) { // rebuild only when the count tuple (or the one-agent rule) changed
      chipSig = sig;
      chips.textContent = "";
      // one agent: its row already says the state, so the count chip only repeats it (2026-10-05)
      for (const k of multi ? CHIP_ORDER : []) {
        if (!n[k]) continue;
        const chip = el("span", "agents-chip", `${n[k]} ${AGENT_WORD[k]}`);
        chip.dataset.state = k;
        chips.appendChild(chip);
      }
    }
    setHidden(clearDone, n.done + n.failed === 0); // nothing to clear → no button (2026-10-05)
  }
  function drawWaiting() {
    setHidden(agentsBlock, waiting.size === 0);
    for (const w of waiting.values()) drawRow(w);
    drawChips();
    drawer.refresh();
    publishAgents();
  }
  let summarySig = "";
  /** Publish the rows as data when any field changed (the 1 s tick usually changes none). */
  function publishAgents() {
    const list: AgentSummary[] = [...waiting].map(([id, w]) => ({
      id, label: w.label, title: w.title, state: agentState(w), selected: drawer.openId() === id, closed: closedTabs.has(id),
    }));
    const sig = JSON.stringify(list);
    if (sig === summarySig) return;
    summarySig = sig;
    liveBlocks.set(agentsBlock, { list, open: openRow, close: closeTab });
    emitAgents(agentsBlock, list);
  }
  function openRow(taskId: string): boolean {
    if (!waiting.has(taskId)) return false;
    if (toggle.getAttribute("aria-expanded") !== "true") setListOpen(true);
    if (drawer.openId() !== taskId) toggleDrawer(taskId);
    return true;
  }
  function closeTab(taskId: string): boolean {
    const w = waiting.get(taskId);
    if (!w || closedTabs.has(taskId)) return false;
    if (drawer.openId() === taskId) closeDrawer();
    if (w.done) {
      dismissed.add(S.sessionId, [taskId]);
      dropRow(taskId);
      settleDoneAgents();
    } else closedTabs.add(taskId);
    drawWaiting();
    refreshState();
    return true;
  }
  function startWaitingTimer() {
    if (S.waitingTimer === undefined) S.waitingTimer = window.setInterval(drawWaiting, 1000);
  }
  function stopWaitingTimer() {
    if (S.waitingTimer !== undefined) { clearInterval(S.waitingTimer); S.waitingTimer = undefined; }
  }

  /** The drawer resizes the transcript viewport without moving scrollTop: a transcript that was at the
   *  bottom (within a few px) stays pinned there, any other position is left alone. */
  function keepPinned(fn: () => void) {
    const t = deps.transcript;
    const pinned = !!t && t.scrollTop + t.clientHeight >= t.scrollHeight - 4;
    fn();
    if (pinned && t) t.scrollTop = t.scrollHeight;
  }
  function closeDrawer() {
    const id = drawer.openId();
    const prev = id !== null ? waiting.get(id) : undefined;
    if (prev) { prev.row.setAttribute("aria-expanded", "false"); drawRow(prev); }
    keepPinned(shutDrawer);
  }
  /** Close the drawer and park its (hidden) element back on the block, out of any row's item. */
  function shutDrawer() {
    drawer.close();
    agentsBlock.appendChild(drawer.el);
  }
  function toggleDrawer(taskId: string) {
    const w = waiting.get(taskId);
    if (!w) return;
    const wasOpen = drawer.openId() === taskId;
    keepPinned(() => {
      closeDrawer();
      if (wasOpen) return;
      w.row.setAttribute("aria-expanded", "true");
      w.row.after(drawer.el); // the body sits directly under the clicked row
      drawer.open(taskId, w);
      drawRow(w);
    });
    publishAgents();
  }

  function addWaiting(taskId: string, toolUseId: string | undefined, fallbackLabel = "Agent") {
    if (waiting.has(taskId)) return;
    if (dismissed.has(S.sessionId, taskId)) return; // cleared earlier: a transcript replay must not bring it back
    const t = toolUseId ? tools.get(toolUseId) : undefined;
    const label = t?.subagentType || fallbackLabel;
    const title = t?.subagentDesc || "";
    const row = el("div", "agent-row");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-expanded", "false");
    const marker = markSlot("running");
    marker.classList.add("agent-marker");
    const word = el("span", "agent-word");
    const name = el("span", "agent-name", label);
    const desc = el("span", "agent-desc", title);
    if (title) name.append(" ", desc);
    const bar = el("span", "agent-bar");
    bar.appendChild(el("i", ""));
    const calls = el("span", "agent-calls");
    const time = el("span", "agent-time");
    const tokensCell = el("span", "agent-calls agent-row-tokens");
    tokensCell.hidden = true;
    const showBtn = btn("Show In Chat", "agent-btn ws-btn agent-show", () => drawer.showInChat());
    showBtn.hidden = true;
    showBtn.addEventListener("click", (e) => e.stopPropagation()); // the row's own click would collapse it
    row.append(marker, word, name, bar, calls, time, tokensCell, showBtn);
    row.addEventListener("click", () => toggleDrawer(taskId));
    row.addEventListener("keydown", (e) => {
      if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      toggleDrawer(taskId);
    });
    const item = el("div", "agent-item"); // row plus, while open, the drawer body right under it
    item.appendChild(row);
    agentsRows.appendChild(item);
    waiting.set(taskId, { label, title, since: Date.now(), toolUseId, done: false, failed: false, needs: false, row, marker, word, bar, calls, time, tokensCell, showBtn, desc });
    startWaitingTimer();
    drawWaiting();
    refreshState();
  }
  /** A SendMessage woke a finished agent: its row runs again, timed from now, with the message's
   *  summary as its sub-line; the old report moves aside (drawer) so the new one can land. No row
   *  (the spawn is outside the hydrated history) adds one labelled with the SendMessage target. */
  function resumeWaiting(taskId: string, toolUseId: string | undefined) {
    if (!S.replaying) closedTabs.delete(taskId);
    const t = toolUseId ? tools.get(toolUseId) : undefined;
    const summary = t?.subagentDesc || "";
    if (dismissed.has(S.sessionId, taskId)) {
      if (S.replaying) return; // still cleared at the end of the live run: the replay keeps it hidden
      dismissed.remove(S.sessionId, taskId);
    }
    const w = waiting.get(taskId);
    if (!w) { addWaiting(taskId, toolUseId, taskId); return; }
    w.parked = undefined;
    if (summary) w.title = summary;
    if (w.desc) {
      w.desc.textContent = w.title;
      w.desc.title = "";
      if (!w.title) w.desc.remove();
      else if (!w.desc.isConnected) w.row.querySelector(".agent-name")?.append(" ", w.desc);
    }
    if (w.done) {
      if (w.report) w.prevReport = w.report;
      w.report = undefined;
      w.tokens = undefined;
      w.done = false;
      w.failed = false;
      w.summaryShown = false;
      w.elapsedFrozen = undefined;
      w.since = Date.now();
      w.row.classList.remove("done");
    }
    startWaitingTimer();
    drawWaiting();
    refreshState();
  }
  function removeWaiting(taskId: string, status?: string, summary?: string, report?: string, tokens?: number) {
    const w = waiting.get(taskId);
    if (!w) return;
    // hand-back and notification each carry part of it (report vs tokens), in either order: keep the first of each
    if (report && !w.report) w.report = report;
    if (tokens && !w.tokens) w.tokens = tokens;
    // the typed notification and the string path can both fire for one task —
    // don't clobber the frozen elapsed time or re-show the summary on a repeat
    if (!w.done) {
      w.done = true;
      w.elapsedFrozen = fmtElapsed(Date.now() - w.since);
      w.failed = !!status && status !== "completed";
    }
    w.row.classList.add("done");
    if (w.toolUseId) { const t = tools.get(w.toolUseId); t?.details.classList.add("landed"); }
    if (summary && !w.summaryShown) { w.summaryShown = true; noticeBlock(summary, status === "completed" ? "info" : "warn"); }
    drawWaiting();
    refreshState();
  }
  /** A typed done notice (notification, hand-back, terminal task_updated). A parked agent's
   *  "completed" is held, not applied: it is the park's, and a wake makes it stale. */
  function taskDone(taskId: string, status?: string, summary?: string, report?: string, tokens?: number, fromUpdate?: boolean) {
    const w = waiting.get(taskId);
    if (w && !w.done && w.parked && !fromUpdate && (!status || status === "completed")) {
      const held = w.parked.held ?? (w.parked.held = { at: Date.now() });
      held.status ??= status;
      held.summary ??= summary;
      held.report ??= report;
      held.tokens ??= tokens;
      return;
    }
    if (w) w.parked = undefined;
    removeWaiting(taskId, status, summary, report, tokens);
  }
  /** Settle a parked row with its held notice (or none). */
  function settleParked(id: string, w: WaitingRow) {
    const held = w.parked?.held;
    w.parked = undefined;
    removeWaiting(id, held?.status, held?.summary, held?.report, held?.tokens);
    if (held) w.elapsedFrozen = fmtElapsed(held.at - w.since);
    drawWaiting();
  }
  /** Drain timers (C4): a drained park with no further live set settles after DRAIN_SETTLE_MS. */
  const drainTimers = new Set<ReturnType<typeof setTimeout>>();
  /** A background_tasks_changed set (REPLACE semantics; task_id == agentId) against the open rows.
   *  Absence closes a row unless subagent-started tasks it may own are still live: then the agent
   *  may be parked on them, so it keeps running until it is listed again (woke) or, once they have
   *  ended, a later set still leaves it out, or DRAIN_SETTLE_MS pass with no set at all (settled
   *  with its held notice). A task whose owner resolved (`owners`, the owning Agent call's
   *  tool_use_id) parks only that row; an unresolved owner, or a row with no tool_use_id, parks
   *  any absent row as before (C1). */
  function liveTasks(taskIds: readonly string[], subagentOwned: readonly string[], owners: Readonly<Record<string, string>> = {}) {
    const mayPark = (w: WaitingRow) => subagentOwned.some((t) => {
      const o = owners[t];
      return o === undefined || !w.toolUseId || o === w.toolUseId;
    });
    for (const [id, w] of [...waiting]) {
      if (w.done) continue;
      if (taskIds.includes(id)) { w.parked = undefined; continue; }
      if (!w.parked) {
        if (mayPark(w)) w.parked = { drained: false };
        else removeWaiting(id);
        continue;
      }
      if (mayPark(w)) continue;
      if (!w.parked.drained) {
        const park = w.parked;
        park.drained = true;
        // the CLI may never wake it (its shell ended, no further set): settle on the held notice
        const timer = setTimeout(() => {
          drainTimers.delete(timer);
          if (waiting.get(id) === w && w.parked === park && !w.done) settleParked(id, w);
        }, DRAIN_SETTLE_MS);
        drainTimers.add(timer);
        continue;
      }
      settleParked(id, w);
    }
  }
  /** turn over: done rows stay, frozen at their elapsed time, as a record of which lanes ran
   *  (2026-10-03: they used to leave with the turn and the record went with them); only
   *  Clear or a finished subtab's X clears them. The timer stops once nothing is still running. */
  function settleDoneAgents() {
    if (runningCount() === 0) stopWaitingTimer();
  }
  /** A resume's history replay carries an Agent launch but not its hand-back or notification, and the
   *  new CLI process owns none of those agents: close every open row, with no elapsed shown (the
   *  true duration is unknown), and stop the tick no `result` would. Idempotent. */
  function settleReplayedAgents() {
    for (const w of waiting.values()) {
      if (w.done) continue;
      w.parked = undefined;
      w.done = true;
      w.failed = false;
      w.elapsedFrozen = "";
      w.row.classList.add("done");
      if (w.toolUseId) tools.get(w.toolUseId)?.details.classList.add("landed");
    }
    drawWaiting();
    refreshState();
    settleDoneAgents();
  }
  /** agents still working (done and failed rows excluded); W2 wires this into the state dot. */
  function runningCount(): number {
    let n = 0;
    for (const w of waiting.values()) if (!w.done) n++;
    return n;
  }
  function dropRow(taskId: string) {
    const w = waiting.get(taskId);
    if (!w) return;
    if (drawer.openId() === taskId) shutDrawer();
    (w.row.parentElement ?? w.row).remove();
    waiting.delete(taskId);
    closedTabs.delete(taskId);
  }
  /** Clear's exit motion (2026-10-05: no instant snap): the row fades while its height, borders
   *  and its share of the list gap collapse, so the rows below glide up. Resolves when done. */
  function fadeOutRow(row: HTMLElement): Promise<void> {
    if (!row.isConnected || matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
    const item = row.parentElement ?? row; // the item animates, so an open body goes with its row
    const cs = getComputedStyle(item);
    const gap = parseFloat(getComputedStyle(agentsRows).rowGap) || 0;
    item.style.pointerEvents = "none";
    item.style.overflow = "hidden";
    const anim = item.animate(
      [
        { opacity: 1, height: cs.height, borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth, marginBottom: "0px" },
        { opacity: 0, height: "0px", borderTopWidth: "0px", borderBottomWidth: "0px", marginBottom: `${-gap}px` },
      ],
      { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" },
    );
    return anim.finished.then(() => undefined, () => undefined);
  }
  let clearing = false;
  async function clearDoneRows() {
    if (clearing) return;
    const gone = [...waiting].filter(([, w]) => w.done).map(([id]) => id);
    if (!gone.length) return;
    clearing = true;
    dismissed.add(S.sessionId, gone);
    // rows stay in `waiting` until the motion ends, so the block doesn't hide under them mid-fade
    await Promise.all(gone.map((id) => fadeOutRow(waiting.get(id)!.row)));
    clearing = false;
    for (const id of gone) dropRow(id);
    if (runningCount() === 0) stopWaitingTimer();
    drawWaiting();
    refreshState();
  }
  function clearWaiting() {
    if (!waiting.size) return;
    shutDrawer();
    waiting.clear();
    closedTabs.clear();
    agentsRows.textContent = "";
    stopWaitingTimer();
    drawWaiting();
    refreshState();
  }
  /** tab dispose: stop the timer and close the drawer so its observer is released */
  function dispose() {
    stopWaitingTimer();
    for (const t of drainTimers) clearTimeout(t);
    drainTimers.clear();
    shutDrawer();
    if (liveBlocks.delete(agentsBlock)) emitAgents(agentsBlock, null);
  }
  return { el: agentsBlock, waiting, addWaiting, resumeWaiting, removeWaiting, taskDone, liveTasks, settleDoneAgents, settleReplayedAgents, clearWaiting, stopWaitingTimer, dispose, runningCount };
}
