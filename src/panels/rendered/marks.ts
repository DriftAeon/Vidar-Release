// Status marks of a Rendered row (tool pill, card, group outcome): one table of states, one
// glyph per state, and `setMark`, which keeps `data-mark` and the legacy state class in step.
// Legacy classes stay: rendered.css and the drive contract still key on them.
// `settled` is a drive-contract class on approval cards (rendered-drive.ts), not a mark.

const MARKS = ["pending", "running", "awaiting", "done", "error", "denied", "answered", "stale", "idle"] as const;
export type Mark = (typeof MARKS)[number];

export const MARK_GLYPH: Record<Mark, string> = {
  pending: "·",
  running: "●",
  awaiting: "?",
  done: "✓",
  error: "✕",
  denied: "✕",
  answered: "✓",
  stale: "–",
  idle: "·",
};

/** A decision outcome outlives the run phase that follows it: a denied or answered pill
 *  still receives `done` from its tool result, and keeps showing the decision. */
const STICKY: readonly Mark[] = ["answered", "denied"];
const END: readonly Mark[] = ["done", "error", "stale"];

/** Set the row's mark. A running/pending/awaiting mark replaces any other non-sticky state
 *  class; an end mark (done/error/stale) clears the in-flight classes and adds its own.
 *  `answered`/`denied` stick: a later end mark adds its legacy class but `data-mark` keeps
 *  the decision (the same classes a pill carried before marks existed). */
export function setMark(node: HTMLElement, mark: Mark): void {
  const sticky = STICKY.find((m) => node.classList.contains(m));
  const keep = sticky !== undefined && END.includes(mark);
  for (const m of MARKS) {
    if (m === mark || STICKY.includes(m)) continue;
    node.classList.remove(m);
  }
  node.classList.add(mark);
  if (!keep) node.dataset.mark = mark;
}

/** Drop `mark` without choosing a successor (a neutral settlement has no state of its own). */
export function clearMark(node: HTMLElement, mark: Mark): void {
  node.classList.remove(mark);
  if (node.dataset.mark === mark) delete node.dataset.mark;
}

/** The small status glyph for a row; textContent only. */
export function markSlot(mark: Mark): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "mark";
  s.dataset.mark = mark;
  s.textContent = MARK_GLYPH[mark];
  return s;
}

/** A status mark with a name for assistive tech and the hover tooltip (an ask's head or badge). */
export function labelledMark(mark: Mark, label: string, glyph: Mark = mark): HTMLSpanElement {
  const s = markSlot(glyph);
  s.dataset.mark = mark;
  s.title = label;
  s.setAttribute("aria-label", label);
  return s;
}
