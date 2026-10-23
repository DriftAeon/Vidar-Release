// Inline heading labels for a Bare set's rune rows. Pure: no DOM, no state.
// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { tabTitleCase } from "../../panels/sessions/tab-state-format.ts";

export interface RuneLabel { depth: number; text: string }

/** A heading as shown: parentheticals stripped, Title Case. */
function clean(h: string): string {
  return tabTitleCase(h.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim());
}

/** The labels to draw before each row, in row order. A leading heading shared by every row is the
 *  set's title and is dropped; a label is emitted only where the heading path changes, from the
 *  first level that differs. Depth 0 draws as `##`, deeper as `###`. Rows with no heading, and sets
 *  with none, get no labels. */
export function rowLabels(sections: readonly (readonly string[])[], all: readonly (readonly string[])[] = sections): RuneLabel[][] {
  // `all` is every brick of the set (the title test); `sections` the ones drawn
  const shared = all.length > 0 && all.every((s) => s.length > 0 && s[0] === all[0][0]);
  let prev: string[] = [];
  return sections.map((s) => {
    const path = (shared ? s.slice(1) : [...s]).map(clean).filter(Boolean);
    const out: RuneLabel[] = [];
    let i = 0;
    while (i < path.length && i < prev.length && path[i] === prev[i]) i++;
    for (; i < path.length; i++) out.push({ depth: i, text: path[i] });
    prev = path;
    return out;
  });
}
