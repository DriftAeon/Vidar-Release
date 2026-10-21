// Run clock: elapsed-time labels for Flow's node footer, stats tile and Output card, plus the
// ticker that keeps an unfinished span moving on its own clock. Painting alone only happens on
// node events (a throttled few per second, none while an agent thinks), so a label built from
// `Date.now()` at paint time froze at its first value (2026-10-02 smoke: 0.1s on a running node).
// A span without `endedAt` is marked `data-live-start`; the ticker rewrites those elements.

/** "12.3s" for the span, or undefined when either end is unreadable or the span runs backwards.
 *  A span with no `endedAt` runs to `nowMs`. */
export function elapsedLabel(startedAt: string | undefined, endedAt: string | undefined, nowMs: number): string | undefined {
  if (!startedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return `${((end - start) / 1000).toFixed(1)}s`;
}

/** Marks `el` to be rewritten by the ticker while the span is unfinished (no `endedAt`); clears
 *  the mark once it has ended. `suffix` is appended to the label (" Total"). */
export function markLive(el: HTMLElement, startedAt: string | undefined, endedAt: string | undefined, suffix = ""): void {
  if (startedAt && !endedAt) {
    el.dataset.liveStart = startedAt;
    el.dataset.liveSuffix = suffix;
  } else {
    delete el.dataset.liveStart;
    delete el.dataset.liveSuffix;
  }
}

/** The Output card's "12.3s Total" for a whole run (start to end, or to now while it runs). */
export function totalLabel(run: { startedAt: string; endedAt?: string } | undefined): string | undefined {
  const t = elapsedLabel(run?.startedAt, run?.endedAt, Date.now());
  return t ? `${t} Total` : undefined;
}

/** Marks the caption's second child (the Total text, when present) live for an unfinished run. */
export function markTotal(cap: HTMLElement, run: { startedAt: string; endedAt?: string } | undefined): HTMLElement {
  const el = cap.children[1] as HTMLElement | undefined;
  if (el && run) markLive(el, run.startedAt, run.endedAt, " Total");
  return cap;
}

/** One tick: rewrites every live element under `root` from `nowMs`. Returns how many it touched. */
export function tickLive(root: ParentNode, nowMs: number): number {
  const els = root.querySelectorAll<HTMLElement>("[data-live-start]");
  els.forEach((el) => {
    const label = elapsedLabel(el.dataset.liveStart, undefined, nowMs);
    if (label) el.textContent = label + (el.dataset.liveSuffix ?? "");
  });
  return els.length;
}

const TICK_MS = 250;

/** Starts the ticker on `document`; the returned function stops it. */
export function startLiveClock(): () => void {
  const id = setInterval(() => tickLive(document, Date.now()), TICK_MS);
  return () => clearInterval(id);
}
