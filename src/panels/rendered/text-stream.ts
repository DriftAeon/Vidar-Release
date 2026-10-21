// Streamed assistant text of a Rendered body: text blocks painted from deltas at a frame
// floor, the final markdown paint, and the interim marking of text that preceded a tool call.

import { renderMarkdownOrText } from "../document";
import { morphInto } from "../../morph";
import { el } from "./dom";
import { addCopyButtons, liftCopyButtons } from "./code-copy";
import { planCard } from "./plan-card";
import type { PlanView } from "../../agents/protocol";
import type { RenderedState } from "./state";
import type { Follow } from "./follow";

/* Floor between stream repaints. rAF alone let a reply re-parse and rebuild up
   to 60x/second for its whole length; a delta arriving inside the floor waits
   for the next frame instead of painting, so nothing is ever dropped — the
   pending frame keeps ticking until the floor elapses and then paints the tail. */
const PAINT_MIN_MS = 45;
/* Each preview repaint re-parses the whole block, so a long reply painted at the floor costs
   O(n²) over its stream. The gap after a paint grows with that paint's cost instead: previews
   spend at most 1/(1+RATIO) of the main thread, and the final paint (textDone) is unchanged. */
const PAINT_COST_RATIO = 4;
type TextBlock = { host: HTMLElement; buf: string; done: boolean; raf: number | undefined; painted: number; cost: number };
/* Paint cost meter. The morph was landed on a Node-only parse benchmark, which
   does not include createElement for the throwaway tree or the diff walk — so
   the real number has to come from the app. Read it over the DevTools port:
   `node tools\drive\vidar-drive.mjs eval "__vidarPaintCost()"`. */
const paintCost: number[] = [];
const debugHost = window as unknown as Record<string, unknown>;
if (!debugHost.__vidarPaintCost) {
  debugHost.__vidarPaintCost = () => {
    if (!paintCost.length) return { n: 0 };
    const s = [...paintCost].sort((a, b) => a - b);
    const at = (q: number) => +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2);
    return { n: s.length, p50: at(0.5), p95: at(0.95), max: +s[s.length - 1].toFixed(2) };
  };
}

/** What the text stream closes over in createRenderedBody. */
export interface TextStreamDeps {
  transcript: HTMLElement;
  follow: Follow;
  append: (node: HTMLElement, parent?: HTMLElement) => void;
  sealGroup: () => void;
  toolHost: (parentToolUseId: string | null) => HTMLElement;
}

export function createTextStream(S: RenderedState, deps: TextStreamDeps) {
  const { transcript, follow, append, sealGroup, toolHost } = deps;
  const textBlocks = new Map<string, TextBlock>();
  /** a top-level tool call landed: every text block of this turn so far was interim */
  function markInterim() {
    if (S.replaying || S.hydrating) return;
    for (const host of S.interimCandidates) if (host.isConnected) host.classList.add("interim");
    S.interimCandidates = [];
  }
  /** the turn ended: the last text is the reply, and the tool rows now mark the earlier ones */
  function clearInterim() {
    for (const b of textBlocks.values()) b.host.classList.remove("interim");
    S.interimCandidates = [];
  }
  function textStart(blockId: string, parent: string | null = null): TextBlock {
    let b = textBlocks.get(blockId);
    if (b) return b;
    // a subagent's text nests under its pill: it must not end the main thread's activity group
    if (!parent) sealGroup();
    // No model eyebrow over replies: the status line carries the model and the
    // user block marks the turn boundary (it flapped whenever
    // the model label passed through "?" and read as noise).
    const host = el("div", "blk blk-text streaming");
    // a subagent's final report is a report, not conversation: it nests under its
    // Agent pill (toolHost falls back to transcript itself if the pill is gone) and
    // reads muted/indented, not like the main assistant's prose
    if (parent) host.classList.add("blk-sub-text");
    b = { host, buf: "", done: false, raf: undefined, painted: 0, cost: 0 };
    textBlocks.set(blockId, b);
    append(host, parent ? toolHost(parent) : transcript);
    if (!parent && !S.replaying && !S.hydrating) S.interimCandidates.push(host);
    return b;
  }
  function textDelta(blockId: string, text: string) {
    const b = textStart(blockId);
    if (b.done) return;
    b.buf += text;
    // a replay only buffers: textDone paints once, partial paints would be thrown away
    if (S.replaying || b.raf !== undefined) return;
    // One handle, re-armed: inside the floor the frame re-queues rather than
    // scheduling a timer, so resetTranscript/dispose still have exactly one
    // thing to cancel per block.
    const tick = () => {
      b.raf = undefined;
      if (b.done) return;
      if (performance.now() - b.painted < Math.max(PAINT_MIN_MS, b.cost * PAINT_COST_RATIO)) { b.raf = requestAnimationFrame(tick); return; }
      b.cost = paintText(b.host, b.buf);
      b.painted = performance.now();
      follow.toBottom();
    };
    b.raf = requestAnimationFrame(tick);
  }
  function textDone(blockId: string, markdown: string, parent: string | null, plan?: PlanView) {
    // an empty close of a block never drawn: nothing to remove, and textStart would seal the tool group
    if (!markdown.trim() && !plan && !textBlocks.has(blockId)) return;
    const b = textStart(blockId, parent);
    b.done = true;
    if (b.raf !== undefined) { cancelAnimationFrame(b.raf); b.raf = undefined; }
    b.host.classList.remove("streaming");
    b.buf = ""; // done blocks never read it again; the final markdown is painted below
    if (plan) {
      // a checklist card, not prose: no reply styling and never interim; a later snapshot of the same turn repaints it
      b.host.className = "blk blk-plan";
      b.host.replaceChildren(planCard(plan));
      follow.toBottom();
      return;
    }
    if (!markdown.trim()) {
      b.host.remove(); textBlocks.delete(blockId); return;
    }
    paintText(b.host, markdown);
    follow.toBottom();
  }
  /** Stream previews and final text share the same safe DOM builder. The built
   *  tree is morphed into what is already on screen rather than replacing it:
   *  untouched paragraphs keep their nodes, so their layout, the user's text
   *  selection and the horizontal scroll of wide <pre> blocks all survive a
   *  repaint. morphInto decides for itself when the root is not comparable
   *  (first paint, rendered <-> fallback, a depth-capped partial tree). */
  function paintText(host: HTMLElement, markdown: string): number {
    const t0 = performance.now();
    const built = renderMarkdownOrText("message.md", markdown, { softBreaks: "br" });
    liftCopyButtons(host);
    if (built.fellBack) {
      const pre = el("pre", "blk-text-fallback", markdown);
      pre.title = built.fellBack.reason;
      morphInto(host, pre);
    } else {
      morphInto(host, built.el);
      addCopyButtons(host);
    }
    const cost = performance.now() - t0;
    if (paintCost.length < 4096) paintCost.push(cost);
    return cost;
  }
  /** dispose's share: no frame may paint into a removed body */
  function cancelFrames() {
    for (const b of textBlocks.values()) if (b.raf !== undefined) cancelAnimationFrame(b.raf);
  }
  /** resetTranscript's share: frames cancelled, blocks and interim candidates forgotten */
  function reset() {
    cancelFrames();
    textBlocks.clear();
    S.interimCandidates = [];
  }
  return { textDelta, textDone, markInterim, clearInterim, cancelFrames, reset };
}
