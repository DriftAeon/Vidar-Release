// The drawer body of an open agent row, placed by the block directly under that row: the task
// description and a read-only list of the child tool pills, re-derived on the block's 1 s tick.
// A finished agent's body leads with the report's verdict, then the full report and the calls
// list, each in a collapsed fold. The row itself carries mark, name, state, time, tokens and Show.
// Nothing is cloned from the transcript: names and summaries are read as text and rebuilt.

import { DASH } from "../../format";
import { renderMarkdownOrText } from "../markdown-build";
import { el } from "./dom";
import { callsIcon, fillCount, toolIcons } from "./chain";
import { MARK_GLYPH, markSlot, type Mark } from "./marks";
import type { ToolRecord, WaitingRow } from "./state";

export type AgentState = "running" | "needs" | "done" | "failed";

export const AGENT_WORD: Record<AgentState, string> = {
  running: "Running",
  needs: "Needs You",
  done: "Done",
  failed: "Failed",
};

const STATE_MARK: Record<AgentState, Mark> = { running: "running", needs: "awaiting", done: "done", failed: "error" };

export function agentState(w: WaitingRow): AgentState {
  if (w.done) return w.failed ? "failed" : "done";
  return w.needs ? "needs" : "running";
}

/** The 1 s tick writes only what changed: each helper skips a write that would store the same value. */
export function setText(node: HTMLElement, v: string): void {
  if (node.textContent !== v) node.textContent = v;
}
export function setHidden(node: HTMLElement, v: boolean): void {
  if (node.hidden !== v) node.hidden = v;
}
export function setState(node: HTMLElement, v: string): void {
  if (node.dataset.state !== v) node.dataset.state = v;
}

export function setSlotMark(slot: HTMLElement, mark: Mark): void {
  if (slot.dataset.mark !== mark) slot.dataset.mark = mark;
  setText(slot, MARK_GLYPH[mark]);
}

export function stateMark(s: AgentState): Mark { return STATE_MARK[s]; }

/** Child pills of the agent's tool record, nested ones included. */
function childPills(t: ToolRecord | undefined): HTMLElement[] {
  if (!t?.children) return [];
  return Array.from(t.children.querySelectorAll<HTMLElement>(".blk-tool"));
}

/** First child pill waiting on the user (its card lives inside it). */
export function awaitingPill(t: ToolRecord | undefined): HTMLElement | null {
  return t?.children?.querySelector<HTMLElement>(".blk-tool.awaiting") ?? null;
}

/** The parent Agent pill's own `.tool-count` already tracks this — read it, never re-count. */
export function fillCalls(cell: HTMLElement, t: ToolRecord | undefined): void {
  const c = t?.details.querySelector<HTMLElement>(":scope > summary .tool-count");
  const sig = callsSig(c);
  if (cellSigs.get(cell) === sig) return; // source count unchanged: leave the cell's nodes alone
  cellSigs.set(cell, sig);
  if (c && c.childNodes.length) {
    cell.replaceChildren(...Array.from(c.childNodes, (n) => n.cloneNode(true)));
    cell.title = c.title;
  } else fillCount(cell, 0, callsIcon(), "0 Calls");
}
const cellSigs = new WeakMap<HTMLElement, string>();
/** Signature of a `.tool-count` source: its text and title (empty source = the "0 Calls" fallback). */
function callsSig(c: HTMLElement | null | undefined): string {
  return c && c.childNodes.length ? `${c.textContent}|${c.title}` : "\0none";
}
function toolCountSig(t: ToolRecord | undefined): string {
  return callsSig(t?.details.querySelector<HTMLElement>(":scope > summary .tool-count"));
}

/** The verdict of a report: its first non-empty line with the markdown markers taken off (heading,
 *  list or quote prefix, emphasis and code ticks). A line over 160 chars is cut at its first sentence end
 *  when one falls inside that; otherwise it stays whole and the row's ellipsis clips it. */
export function reportVerdict(report: string): string {
  const line = report.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const plain = line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
  if (plain.length <= 160) return plain;
  const end = /[.!?](\s|$)/.exec(plain);
  return end && end.index < 160 ? plain.slice(0, end.index + 1) : plain;
}

export interface AgentsDrawerDeps {
  tools: Map<string, ToolRecord>;
}

export function createAgentsDrawer(deps: AgentsDrawerDeps) {
  const { tools } = deps;
  const root = el("div", "agent-drawer");
  root.hidden = true;
  const body = el("div", "agent-drawer-body");
  const desc = el("div", "agent-drawer-desc");
  const needsLine = el("div", "agent-drawer-needs");
  const list = el("div", "agent-calls-list");
  // finished agents: verdict, then the full report and the calls list each behind a collapsed fold
  const verdict = el("div", "agent-drawer-verdict");
  const reportFold = el("details", "agent-fold");
  const reportSum = el("summary", "agent-btn ws-btn agent-fold-sum", "Report");
  const reportBody = el("div", "agent-report");
  reportFold.append(reportSum, reportBody);
  const callsFold = el("details", "agent-fold");
  const callsSum = el("summary", "agent-btn ws-btn agent-fold-sum");
  callsFold.append(callsSum);
  body.append(desc, needsLine, list);
  root.append(body);

  let openId: string | null = null;
  let listSig = "";
  let reportSig: string | undefined;
  let finished: boolean | undefined;
  let current: WaitingRow | undefined;
  let countSig = "";
  let obs: MutationObserver | undefined;
  let watched: HTMLElement | undefined;
  let mutated = false;
  /** set by open(): the next list pass lands at the awaiting call, else at the newest one */
  let jumpOnBuild = false;

  /** The body is a scroller (rendered-agents.css): newest calls are at its end. */
  function atBottom(): boolean {
    return body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
  }
  /** Scroll the body (only the body, never an ancestor) just enough to show `line`. */
  function bringIntoView(line: HTMLElement) {
    const b = body.getBoundingClientRect();
    const r = line.getBoundingClientRect();
    if (r.top < b.top) body.scrollTop += r.top - b.top;
    else if (r.bottom > b.bottom) body.scrollTop += r.bottom - b.bottom;
  }

  /** True when the watched children node was re-targeted or mutated since the last pass. */
  function watch(target: HTMLElement | undefined): boolean {
    if (typeof MutationObserver === "undefined") return true;
    let dirty = false;
    if (target !== watched) {
      obs?.disconnect();
      watched = target;
      dirty = true;
      if (target) {
        obs ??= new MutationObserver(() => { mutated = true; });
        obs.observe(target, { attributes: true, childList: true, characterData: true, subtree: true });
      }
    }
    if (obs && obs.takeRecords().length) dirty = true;
    if (mutated) { dirty = true; mutated = false; }
    return dirty;
  }

  /** Running and finished agents lay the body out differently; the calls list is one element moved between them. */
  function layout(done: boolean) {
    if (finished === done) return;
    finished = done;
    root.dataset.done = String(done);
    if (done) {
      callsFold.append(list);
      body.replaceChildren(desc, verdict, reportFold, callsFold); // the head is gone: the task description leads the body
    } else body.replaceChildren(desc, needsLine, list, reportFold); // the fold: a resumed agent's previous report
  }
  function fillReport(report: string | undefined) {
    if (report === reportSig) return;
    reportSig = report;
    const v = report ? reportVerdict(report) : "";
    verdict.textContent = v || DASH;
    verdict.classList.toggle("is-empty", !v);
    reportFold.hidden = !report;
    if (!report) { reportBody.textContent = ""; return; }
    const built = renderMarkdownOrText("report.md", report, { softBreaks: "br" });
    if (built.fellBack) {
      const pre = el("pre", "blk-text-fallback", report);
      pre.title = built.fellBack.reason;
      reportBody.replaceChildren(pre);
    } else reportBody.replaceChildren(built.el);
  }

  /** Open every collapsed <details> above `node` (group, agent pill) so it is visible, then bring it into view. */
  function reveal(node: HTMLElement) {
    for (let d = node.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
    node.scrollIntoView({ block: "nearest" });
  }
  function showInChat() {
    if (!current?.toolUseId) return;
    const t = tools.get(current.toolUseId);
    if (!t) return;
    const pill = awaitingPill(t);
    if (pill) reveal(pill.querySelector<HTMLElement>(".blk-approval, .blk-question") ?? pill);
    else reveal(t.details);
  }

  function refresh() {
    const w = current;
    if (openId === null || !w) return;
    setText(desc, w.title);
    setHidden(desc, !w.title);
    layout(w.done);
    fillReport(w.done ? w.report : w.prevReport);
    const t = w.toolUseId ? tools.get(w.toolUseId) : undefined;
    // Skip rule: the pill query and list work run only when something under the agent's children may have
    // changed. A MutationObserver on t.children (attributes, child list, text, whole subtree) sets `dirty`
    // for any mark flip (pending to ok sets data-mark), new pill, summary text or awaiting-class change;
    // takeRecords() flushes mutations not yet delivered. The tool-count signature and a re-targeted or
    // missing children node also force a pass; with no MutationObserver every tick does.
    const sig2 = toolCountSig(t);
    const pending = watch(t?.children ?? undefined);
    if (!pending && sig2 === countSig && listSig !== "\0") return;
    countSig = sig2;
    const pill = awaitingPill(t);
    setHidden(needsLine, !pill);
    if (pill) setText(needsLine, `Waiting On ${pill.dataset.tool ?? "A Tool"}`);
    const pills = childPills(t);
    const rows = pills.map((p) => ({
      mark: (p.dataset.mark ?? "pending") as Mark,
      tool: p.dataset.tool ?? "",
      text: p.querySelector<HTMLElement>(":scope > summary .tool-summary")?.textContent ?? "",
    }));
    // rebuild only on change: a rebuild every tick would reset the drawer's scroll
    const sig = rows.map((r) => `${r.mark}|${r.tool}|${r.text}`).join("\n");
    if (sig === listSig) return;
    listSig = sig;
    // read before the rebuild changes the height: a reader at the newest call stays pinned there
    const stick = jumpOnBuild || atBottom();
    const jump = jumpOnBuild;
    jumpOnBuild = false;
    callsSum.replaceChildren(el("span", "agent-fold-n", String(rows.length)), rows.length === 1 ? " Call" : " Calls");
    list.textContent = "";
    if (!rows.length) list.append(el("div", "agent-calls-empty", DASH));
    const awaitAt = pill ? pills.indexOf(pill) : -1;
    let awaitLine: HTMLElement | null = null;
    for (const [i, r] of rows.entries()) {
      const line = el("div", "agent-call");
      const m = markSlot(r.mark);
      const tool = el("span", "agent-call-tool");
      tool.append(...toolIcons(r.tool), el("span", "agent-call-name", r.tool)); // no icon for the tool: the name alone
      line.append(m, tool, el("span", "agent-call-text", r.text));
      list.appendChild(line);
      if (i === awaitAt) awaitLine = line;
    }
    if (stick) body.scrollTop = body.scrollHeight;
    // opened on an agent that waits on the user: that call, not the newest, is what must be in view
    if (jump && awaitLine) bringIntoView(awaitLine);
  }

  function open(taskId: string, w: WaitingRow) {
    openId = taskId;
    current = w;
    listSig = "\0";
    obs?.disconnect();
    watched = undefined;
    mutated = false;
    reportSig = "\0"; // a fresh agent: rebuild the report and start both folds collapsed
    reportFold.open = false;
    callsFold.open = false;
    root.hidden = false;
    jumpOnBuild = true; // a ~100-call agent opens at its newest (or awaiting) call, not its first
    refresh();
  }
  function close() {
    openId = null;
    current = undefined;
    obs?.disconnect();
    watched = undefined;
    root.hidden = true;
  }

  return { el: root, open, close, refresh, showInChat, openId: () => openId };
}
