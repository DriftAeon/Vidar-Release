// Activity groups of a Rendered body: the <details> that collect consecutive top-level
// tool pills and thoughts, their one-line summary, sealing and collapsing at turn end.

import { el } from "./dom";
import { cardShell } from "./card-shell";
import { renderChain } from "./chain";
import type { RenderedAgent } from "./transport";
import type { Group, RenderedState } from "./state";
import type { HydrateStats } from "./hydrate-stats";

/** What the groups close over in createRenderedBody. */
export interface GroupsDeps {
  append: (node: HTMLElement, parent?: HTMLElement) => void;
  agent: RenderedAgent;
  stats?: HydrateStats;
}

export function createGroups(S: RenderedState, deps: GroupsDeps) {
  const { append, agent, stats } = deps;
  /** Thought is header-only, so an open thought has no row to carry its
   *  running state — the group holds the outstanding ids instead. */
  const openThoughts = new Map<string, Group>();
  /** every thought id this transcript has counted, so a late duplicate cannot re-count */
  const seenThoughts = new Set<string>();

  /* -- activity groups -- */

  /** the group collecting now, or a new one; open while live, collapsed on replay */
  function groupFor(): Group {
    if (S.curGroup && !S.curGroup.sealed) return S.curGroup;
    const details = cardShell({ root: "details", classes: "blk blk-activity" }).root as HTMLDetailsElement;
    details.open = !S.replaying;
    // live: while the turn runs only the newest pill shows (rendered-chain.css), so the
    // transcript holds its height instead of growing a row per call (2026-10-05)
    if (!S.replaying) details.dataset.live = "";
    const summary = el("summary", "");
    const label = el("span", "activity-label chain-bar");
    // no disclosure chevron: the whole row toggles (2026-10-04: the chevron read oddly)
    summary.append(label, el("span", "chain-rt"));
    details.appendChild(summary);
    const g: Group = { details, label, counts: new Map(), sealed: false, error: false, userToggled: false, thinking: new Set() };
    // a user click is remembered so turn_done / late errors leave the group alone
    // while live the first click expands the one-line tail to the full list instead of folding
    summary.addEventListener("click", (e) => {
      g.userToggled = true;
      if (details.open && "live" in details.dataset) { e.preventDefault(); delete details.dataset.live; }
    });
    S.curGroup = g;
    stats?.groupCreated();
    S.turnGroups.push(g);
    append(details);
    return g;
  }
  /** a conversation-level block landed: the current group stops collecting */
  function sealGroup(keepOpen = false) {
    const g = S.curGroup;
    S.curGroup = null;
    if (!g) return;
    g.sealed = true;
    // a `!` command group (bang.ts) keeps its output on screen until turn_done
    if (keepOpen) g.keepOpen = true;
    foldSealed(g);
  }
  function isRunning(g: Group) {
    // an open thought has no row of its own any more, so it is counted, not queried
    return g.thinking.size > 0
      || !!g.details.querySelector(":scope > .blk-tool.running, :scope > .blk-tool.pending, :scope > .blk-tool.awaiting");
  }
  /** a sealed group that has nothing running folds now instead of waiting for turn_done; once,
   *  so a later user click or a groupError reopening is not fought */
  function foldSealed(g: Group) {
    if (S.replaying || !g.sealed || g.folded || g.keepOpen || g.userToggled || g.error || isRunning(g)) return;
    g.folded = true;
    delete g.details.dataset.live;
    g.details.open = false;
  }
  function groupCount(g: Group, name: string) {
    g.counts.set(name, (g.counts.get(name) ?? 0) + 1);
    groupRefresh(g);
  }
  /** summary from direct members only; marker from their live state */
  function groupRefresh(g: Group) {
    const running = isRunning(g);
    g.details.dataset.state = running ? "running" : g.error ? "error" : "idle";
    // the joined bar (a segment per tool name, the Ask segment carries its outcome) and the
    // "N Ops" total with the group's mark: chain.ts
    renderChain(g, agent, running);
    // nothing to disclose (a thoughts-only group) → one flat line, no triangle
    g.details.classList.toggle("empty", !g.details.querySelector(":scope > :not(summary)"));
    foldSealed(g);
  }
  function groupError(g: Group) {
    g.error = true;
    // a live error opens the group (even after turn_done collapsed it); replay stays folded
    if (!g.userToggled && !S.replaying) g.details.open = true;
    groupRefresh(g);
  }
  function collapseTurnGroups() {
    for (const g of S.turnGroups) {
      delete g.details.dataset.live;
      if (!g.userToggled && !g.error) g.details.open = false;
    }
    S.turnGroups = [];
  }
  /** A thought is a count in the group header and nothing else. The adapter
   *  forwards no thinking content, so every row was a label with nothing under it,
   *  and a column of them said nothing. Only the running state
   *  needs keeping: the ids still open, held on the group. */
  function thinkingBlock(blockId: string, done: boolean) {
    const key = `think:${blockId}`;
    let g = openThoughts.get(key);
    if (!g) {
      // a repeat of an id we already settled must not count twice
      if (seenThoughts.has(key)) return;
      seenThoughts.add(key);
      g = groupFor();
      openThoughts.set(key, g);
      g.thinking.add(key);
      groupCount(g, "Thought"); // refreshes
    }
    if (done) settleThought(key);
  }
  function settleThought(key: string) {
    const g = openThoughts.get(key);
    if (!g) return;
    openThoughts.delete(key);
    g.thinking.delete(key);
    groupRefresh(g);
  }
  /** turn over, or the process died: nothing else will settle these */
  function settleThoughts() {
    for (const key of [...openThoughts.keys()]) settleThought(key);
  }
  /** resetTranscript's share: forget the open and counted thoughts */
  function reset() {
    openThoughts.clear();
    seenThoughts.clear();
  }
  return { groupFor, sealGroup, groupCount, groupRefresh, groupError, collapseTurnGroups, thinkingBlock, settleThoughts, reset };
}
