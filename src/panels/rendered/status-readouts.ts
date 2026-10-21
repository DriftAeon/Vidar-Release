// The right-hand readouts of the status bar: context (Con), the 5-hour window (5H) and the
// 7-day window (7D), as chunk bars. Pure builders over the status line's numbers.

import { el } from "./dom";
import { fmtTokens } from "./format";
import { svgEl } from "./icons";
import type { StatusLine } from "./state";

const pctClass = (p: number) => (p >= 90 ? "sl-bad" : p >= 70 ? "sl-warn" : "sl-ok");

/** fraction (0-1) of chunk `i` filled when `n` chunks show `pct`: each chunk is 100/n %, filled gradually */
const chunkPart = (pct: number, n: number, i: number) => Math.max(0, Math.min(1, (pct / 100) * n - i));

function chunkBar(n: number, pct: number): HTMLElement {
  const bar = el("span", "chunk-bar");
  for (let i = 0; i < n; i++) {
    const c = el("i", "chunk");
    const fill = el("i", "chunk-fill");
    fill.style.height = `${chunkPart(pct, n, i) * 100}%`; // data-driven height, not a style value
    c.appendChild(fill);
    bar.appendChild(c);
  }
  return bar;
}

const clock = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const weekday = (sec: number) => new Date(sec * 1000).toLocaleDateString([], { weekday: "short" });

function contextReadout(sl: StatusLine): HTMLElement | null {
  if (sl.ctxPct !== null) {
    const c = el("span", `sl-rd sl-con ${sl.ctxPct >= 75 ? "sl-bad" : "sl-orange"}`);
    c.title = `${fmtTokens(sl.ctxTokens)} of ${fmtTokens(sl.contextWindow ?? 0)} tokens`; // copy-ok: tooltip sentence, unchanged from status-bar.ts
    const bar = el("span", "mini-bar");
    const fill = el("i", "mini-fill");
    fill.style.width = `${Math.max(0, Math.min(100, sl.ctxPct))}%`; // data-driven width, not a style value
    bar.appendChild(fill);
    c.append(el("span", "rd-label", "Con"), bar, el("span", "rd-num", `${sl.ctxPct}%`));
    return c;
  }
  if (sl.ctxTokens) return el("span", "sl-rd sl-con sl-orange", `Con ${fmtTokens(sl.ctxTokens)}`);
  return null;
}

/** A window whose reset time has passed reads as reset (0%, no reset time) until the next rate-limit
 *  event brings its new numbers: the last event's % belongs to the window that ended. */
function current(l: { pct: number; resetsAt: number | null } | undefined, nowSec: number) {
  if (!l || l.resetsAt === null || l.resetsAt > nowSec) return l;
  return { ...l, pct: 0, resetsAt: null };
}

/** Con, 5H and 7D in that order; null when none has data. */
export function statusReadouts(sl: StatusLine, nowMs = Date.now()): HTMLElement | null {
  const wrap = el("span", "sl-readouts");
  const con = contextReadout(sl);
  if (con) wrap.appendChild(con);
  const five = current(sl.limits.get("five_hour"), nowMs / 1000);
  if (five) {
    const r = el("span", `sl-rd sl-five ${pctClass(five.pct)}`);
    r.title = `5-Hour Window: ${five.pct}% Used${five.resetsAt !== null ? ` · Resets ${clock(five.resetsAt)}` : ""}`;
    r.append(svgEl("clock", "5-Hour Window"), chunkBar(5, five.pct), el("span", "rd-num", `${five.pct}%`));
    wrap.appendChild(r);
  }
  const week = current(sl.limits.get("seven_day"), nowMs / 1000);
  if (week) {
    const r = el("span", `sl-rd sl-week ${pctClass(week.pct)}`);
    r.title = `7-Day Window: ${week.pct}% Used${week.resetsAt !== null ? ` · Resets ${weekday(week.resetsAt)}` : ""}`;
    r.append(svgEl("calendar", "7-Day Window"), chunkBar(5, week.pct)); // bars only; the % is in the title (2026-10-04)
    wrap.appendChild(r);
  }
  return wrap.childElementCount ? wrap : null;
}
