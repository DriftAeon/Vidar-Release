// Effort as a row of segments, one per level the agent offers, filled up to the current one.
// Each segment is `button.eff-seg[data-level]`; ←/→ move focus (roving tabindex), Enter/Space
// pick through the native button click.

import type { Effort } from "../../agents/protocol";
import { btn, el } from "./dom";

const SHORT: Record<Effort, string> = { low: "L", medium: "M", high: "H", xhigh: "X", max: "MX" };
const LONG: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };

export interface EffortSegmentsOpts {
  levels: readonly Effort[];
  /** the level the last report named; "" before the first report (nothing filled) */
  current: string;
  /** disables every segment (dead or starting; a change in flight leaves them enabled) */
  blocked: boolean;
  /** a change is in flight: the group dims */
  pending: boolean;
  onPick: (level: Effort) => void;
}

/** the group plus `update`, which re-marks the existing segments in place (no rebuild, so focus
 *  and unchanged segments stay put; 2026-10-04: a pick redrew the whole row) */
export type EffortGroup = HTMLElement & { update(o: Omit<EffortSegmentsOpts, "levels" | "onPick">): void; levels: readonly Effort[] };

export function effortSegments(o: EffortSegmentsOpts): EffortGroup {
  const group = el("div", "eff-group") as unknown as EffortGroup;
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Effort");
  let current = o.current;
  const segs = o.levels.map((level) => {
    const b = btn(SHORT[level] ?? level, "eff-seg", () => { if (level !== current) o.onPick(level); });
    b.dataset.level = level;
    b.title = LONG[level] ?? level;
    return b;
  });
  group.append(...segs);
  group.levels = o.levels;
  group.update = (u) => {
    current = u.current;
    group.classList.toggle("pending", u.pending);
    const curIdx = o.levels.findIndex((l) => l === u.current);
    const tabIdx = curIdx >= 0 ? curIdx : 0;
    const focusedIdx = segs.indexOf(document.activeElement as HTMLButtonElement);
    segs.forEach((b, i) => {
      if (b.disabled !== u.blocked) b.disabled = u.blocked;
      // keep a focused segment tabbable; otherwise the roving stop sits on the current level
      b.tabIndex = i === (focusedIdx >= 0 ? focusedIdx : tabIdx) ? 0 : -1;
      b.setAttribute("aria-pressed", String(i === curIdx));
      b.classList.toggle("on", i <= curIdx);
      b.classList.toggle("cur", i === curIdx);
      b.classList.toggle("sl-effort", i === curIdx);
    });
  };
  group.update(o);
  group.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = segs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = segs[(i + (e.key === "ArrowRight" ? 1 : segs.length - 1)) % segs.length];
    segs.forEach((s) => { s.tabIndex = s === next ? 0 : -1; });
    next.focus();
    e.preventDefault();
  });
  return group;
}