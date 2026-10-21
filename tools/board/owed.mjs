// owed: the "owed to the user at run close" rule as a check. A closed run's NOTES.md must carry an
// `## Owed to the user` section whose every line is a park marker (`- parked <id>: ...`) or `- none`.
//   import { owedGaps, OWED_SINCE, PARK_MARK } from "./owed.mjs";  owedGaps([{ name, notes, context }])
// Returns [{ run, problem }]. Pure: no file reads; where.mjs feeds it the run folders. Node built-ins only.
// Refuses nothing at runtime; it only reports. Runs dated before OWED_SINCE and runs not yet closed are never flagged.
export const OWED_SINCE = "2026-10-08";
export const PARK_MARK = /^\s*- (un)?parked [A-Za-z0-9._-]+: /; // the one marker shape where.mjs and this check share

const CLOSED_NOTES = /\brun closed\b|\bclosed by (the )?user\b/i;
const CLOSED_CONTEXT = /^Status:\s*merged/im;
const HEADING = /^#{2,}\s*Owed to the user\b/i;
const clip = (s, n = 100) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function owedGaps(runs) {
  const gaps = [];
  for (const { name, notes = "", context = "" } of runs) {
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(name)?.[1];
    if (!date || date < OWED_SINCE) continue;
    if (!CLOSED_NOTES.test(notes) && !CLOSED_CONTEXT.test(context)) continue;
    const lines = notes.split(/\r?\n/);
    const at = lines.findIndex((l) => HEADING.test(l));
    if (at < 0) {
      gaps.push({ run: name, problem: 'no "Owed to the user" heading' });
      continue;
    }
    let seen = false;
    for (const l of lines.slice(at + 1)) {
      if (/^#+\s/.test(l)) break;
      if (!l.trim()) continue;
      seen = true;
      if (!PARK_MARK.test(l) && !/^\s*- none\s*$/i.test(l)) gaps.push({ run: name, problem: `owed item not parked: ${clip(l.trim())}` });
    }
    if (!seen) gaps.push({ run: name, problem: 'empty "Owed to the user" section (write - none)' });
  }
  return gaps;
}
