// Tool pills of a Rendered body: a pill per tool call, pending → running → done/error/stale,
// nested under its parent pill for subagents and counted in its activity group.

import { callsIcon, fillCount, setTarget, shortLabel, toolBadge } from "./chain";
import { clip, commandInputText, pretty, toolSummary } from "./format";
import { el } from "./dom";
import { askAnswersBlock } from "./ask-answers";
import { EDIT_TOOLS } from "./edit-diff";
import { editPillBody } from "./edit-pill";
import { toolClass } from "./tool-class";
import type { RenderedAgent } from "./transport";
import { cardShell } from "./card-shell";
import { clearMark, setMark } from "./marks";
import type { Group, RenderedState, ToolRecord } from "./state";

export const OUTPUT_SHOW_MAX = 256 * 1024; // chars of a tool output shown expanded; sidecar caps bytes too
const STALE_SUFFIX = " — no result recorded";
const STALE_NOTE = "tool-stale-note"; // no CSS: reads as the summary's own text

/** A pill body <pre> whose text is built when its `owner` details first opens (or now, if it
 *  is open): a closed pill holds a thunk, not a pretty-printed text node of up to 256K. The
 *  <pre> goes in at its usual place, so order and classes are unchanged. The summary click
 *  fills it before the open paints; `toggle` covers opens from code (an approval card). */
function lazyPre(owner: HTMLDetailsElement, cls: string, text: () => string): HTMLPreElement {
  const pre = el("pre", cls);
  let make: (() => string) | null = text;
  const fill = () => {
    if (!make) return;
    pre.textContent = make();
    make = null;
    owner.removeEventListener("toggle", onToggle);
    owner.removeEventListener("click", onClick);
  };
  const onToggle = () => { if (owner.open) fill(); };
  const onClick = (e: Event) => { if ((e.target as Element | null)?.closest("summary")?.parentElement === owner) fill(); };
  if (owner.open) fill();
  else { owner.addEventListener("toggle", onToggle); owner.addEventListener("click", onClick); }
  return pre;
}

/** What the tool pills close over in createRenderedBody. */
export interface ToolPillsDeps {
  transcript: HTMLElement;
  tools: Map<string, ToolRecord>;
  awaiting: Map<string, HTMLElement>;
  append: (node: HTMLElement, parent?: HTMLElement) => void;
  groupFor: () => Group;
  groupCount: (g: Group, name: string) => void;
  groupRefresh: (g: Group) => void;
  groupError: (g: Group) => void;
  markInterim: () => void;
  attachCard: (toolUseId: string, card: HTMLElement) => void;
  agent: RenderedAgent;
}

// S is unused today; kept for the createX(S, deps) shape every rendered/* factory shares.
export function createToolPills(_S: RenderedState, deps: ToolPillsDeps) {
  const { transcript, tools, awaiting, append, groupFor, groupCount, groupRefresh, groupError, markInterim, attachCard, agent } = deps;
  function toolHost(parentToolUseId: string | null): HTMLElement {
    if (!parentToolUseId) return transcript;
    const p = tools.get(parentToolUseId);
    if (!p) return transcript;
    if (!p.children) {
      p.children = el("div", "tool-children");
      p.details.appendChild(p.children);
    }
    return p.children;
  }
  function toolPending(toolUseId: string, name: string, parent: string | null) {
    if (tools.has(toolUseId)) return;
    const details = cardShell({ root: "details", classes: "blk blk-tool" }).root as HTMLDetailsElement;
    setMark(details, "pending");
    details.dataset.tool = name;
    details.dataset.toolClass = toolClass(name, agent);
    const summary = el("summary", "");
    // class badge, short name, mono target; the empty .mark takes its state from the row's data-mark (CSS)
    summary.append(toolBadge(name), el("span", "tool-name", shortLabel(name)), el("span", "tool-summary", "…"), el("span", "mark"));
    details.appendChild(summary);
    // top-level pills live in the current activity group; subagent children
    // keep nesting under their parent pill and are not group members
    const group = parent ? null : groupFor();
    if (group) markInterim();
    const t = { details, out: null, children: null, name, group, card: null };
    tools.set(toolUseId, t);
    append(details, group ? group.details : toolHost(parent));
    if (group) groupCount(group, name);
    // the approval card got here first: move it into the pill
    const card = awaiting.get(toolUseId);
    if (card) { awaiting.delete(toolUseId); attachCard(toolUseId, card); }
  }
  function toolStart(toolUseId: string, name: string, input: unknown, truncated: number | undefined, parent: string | null) {
    toolPending(toolUseId, name, parent);
    const t = tools.get(toolUseId)!;
    if (name === "Agent" && input && typeof input === "object") {
      const i = input as Record<string, unknown>;
      if (typeof i.subagent_type === "string") t.subagentType = i.subagent_type;
      if (typeof i.description === "string") t.subagentDesc = i.description;
    }
    // a SendMessage may resume a finished agent: its target and summary label that agent's row
    if (name === "SendMessage" && input && typeof input === "object") {
      const i = input as Record<string, unknown>;
      if (typeof i.to === "string") t.subagentType = i.to;
      if (typeof i.summary === "string") t.subagentDesc = i.summary;
    }
    if (t.details.classList.contains("awaiting")) clearMark(t.details, "pending");
    else setMark(t.details, "running");
    const summary = t.details.querySelector<HTMLElement>(".tool-summary");
    if (summary) setTarget(summary, toolSummary(name, input), truncated ? ` [input truncated: ${truncated} B]` : "");
    const inp = lazyPre(t.details, "tool-input", () => name === "Command" ? commandInputText(input) : pretty(input));
    t.details.appendChild(inp);
    const parentTool = parent ? tools.get(parent) : null;
    if (parentTool) {
      const cnt = parentTool.children?.childElementCount ?? 0;
      const ps = parentTool.details.querySelector<HTMLElement>(".tool-count");
      const calls = (node: HTMLElement) => fillCount(node, cnt, callsIcon(), `${cnt} ${cnt === 1 ? "Call" : "Calls"}`);
      if (ps) calls(ps);
      else {
        const c = el("span", "tool-count");
        calls(c);
        const sum = parentTool.details.querySelector(":scope > summary");
        // before the mark, so the mark stays the rightmost cell
        sum?.insertBefore(c, sum.querySelector(":scope > .mark"));
      }
    }
    if (t.group) groupRefresh(t.group);
  }
  function toolDone(toolUseId: string, content: string, isError: boolean, structured: unknown, truncated: number | undefined, parent: string | null) {
    if (!tools.has(toolUseId)) {
      // result without a start (its tool_use line was dropped): synthesise the pill
      toolPending(toolUseId, "tool", parent);
      const t = tools.get(toolUseId)!;
      const summary = t.details.querySelector<HTMLElement>(".tool-summary");
      if (summary) summary.textContent = "(call not seen)";
    }
    const t = tools.get(toolUseId)!;
    setMark(t.details, isError ? "error" : "done");
    // a pill marked stale (exit, replay ended mid-call) that finishes after all drops the stale note
    t.details.querySelector(`:scope > summary > .tool-summary > .${STALE_NOTE}`)?.remove();
    if (t.group) { if (isError) groupError(t.group); else groupRefresh(t.group); }
    // a descendant error still marks the top-level group
    if (isError && parent) { const top = topGroupOf(parent); if (top) groupError(top); }
    const shown = () => (content.length > OUTPUT_SHOW_MAX ? content.slice(0, OUTPUT_SHOW_MAX) + `\n… ${content.length - OUTPUT_SHOW_MAX} more chars` : content);
    // an answered Ask shows the picked answers; unparsed text falls back to the raw output below
    const answers = !isError && toolClass(t.name, agent) === "ask" ? askAnswersBlock(content) : null;
    // a successful edit shows its changed lines, not the input JSON and the "updated successfully" sentence
    if (!answers && !isError && EDIT_TOOLS.has(t.name) && editPillBody(t.details, structured, OUTPUT_SHOW_MAX)) return;
    if (answers) t.details.appendChild(answers);
    else {
      const out = lazyPre(t.details, "tool-output", () => shown() + (truncated ? `\n[output truncated by sidecar: ${truncated} B]` : ""));
      t.out = out;
      t.details.appendChild(out);
    }
    if (!answers && structured !== undefined && structured !== null) {
      const sd = el("details", "tool-structured");
      sd.append(el("summary", "", "Structured Result"));
      sd.append(lazyPre(sd, "", () => { const js = pretty(structured); return js.length > OUTPUT_SHOW_MAX ? js.slice(0, OUTPUT_SHOW_MAX) + "\n… (more)" : js; }));
      t.details.appendChild(sd);
    }
    // a one-line hint in the summary: first line of the result or "error"
    const summary = t.details.querySelector<HTMLElement>(".tool-summary");
    if (summary && isError) summary.textContent = clip(`error: ${content.split("\n")[0]}`);
  }
  /** the activity group of a tool's top-most ancestor pill */
  function topGroupOf(toolUseId: string): Group | null {
    const t = tools.get(toolUseId);
    if (!t) return null;
    if (t.group) return t.group;
    for (const [id, o] of tools) if (o.children && o.children.contains(t.details)) return topGroupOf(id);
    return null;
  }
  /** a pill that will never get a result (exit, or replay ended mid-call) */
  function stalePill(t: { details: HTMLDetailsElement; group: Group | null }) {
    setMark(t.details, "stale");
    const s = t.details.querySelector<HTMLElement>(".tool-summary");
    // its own span, so setTarget's URL spans survive and recovery removes exactly this
    if (s && !s.querySelector(`:scope > .${STALE_NOTE}`)) s.append(el("span", STALE_NOTE, STALE_SUFFIX));
    if (t.group) groupRefresh(t.group);
  }
  return { toolHost, toolPending, toolStart, toolDone, stalePill };
}
