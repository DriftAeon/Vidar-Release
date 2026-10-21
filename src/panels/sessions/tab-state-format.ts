// Pure text and counting helpers for the left-bar tab rows (feeds and paint). DOM-free, no imports.

const SMALL_WORDS = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "for", "by", "vs"]);

/** A tab name as the row shows it: Title Case words, short words lower case unless first. Words with
 *  a capital past the first letter, a digit, or one of `. / \ :` stay as typed. Display only. */
export function tabTitleCase(name: string): string {
  let first = true;
  return name.split(/(\s+)/).map((w) => {
    if (!w.trim()) return w;
    const isFirst = first;
    first = false;
    if (/[0-9./\\:]/.test(w) || /.[A-Z]/.test(w)) return w;
    const lower = w.toLowerCase();
    if (!isFirst && SMALL_WORDS.has(lower)) return lower;
    return w[0].toUpperCase() + w.slice(1);
  }).join("");
}

/** The Relay row's reason line: non-zero counts by kind, `1 Ask · 1 Display`; empty when none. */
export function relayCountText(views: readonly string[]): string {
  const parts: string[] = [];
  for (const [type, one, many] of [["ask", "Ask", "Asks"], ["display", "Display", "Displays"], ["doc", "Doc", "Docs"]] as const) {
    const n = views.filter((v) => v === type).length;
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  }
  return parts.join(" · ");
}

/** Pending asks per tab: each ask's Falcon session resolved through `resolve`; unresolved asks count nowhere. */
export function countAsksByTab(sessions: readonly string[], resolve: (session: string) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const tab = resolve(s);
    if (tab) counts.set(tab, (counts.get(tab) ?? 0) + 1);
  }
  return counts;
}
