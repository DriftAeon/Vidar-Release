// The changed-line list of a finished Edit/Write/MultiEdit pill, from the tool's structured
// result: + and − lines only (context dropped), the first `cap` shown, the rest behind a
// "+N More Lines" toggle, and the totals for the summary row. No DOM: tests import it bare.

export type DiffLine = { kind: "add" | "del"; text: string };
export interface EditDiff {
  shown: DiffLine[];
  rest: DiffLine[];
  added: number;
  removed: number;
}

/** lines shown before the "+N More Lines" toggle (mock B1 default, user-approved 2026-10-05) */
const EDIT_DIFF_CAP = 8;
/** the tools whose open pill is the line list instead of input JSON plus output sentence */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit"]);

/** null when the result carries nothing to list: the caller falls back to the raw output */
export function editDiff(structured: unknown, cap = EDIT_DIFF_CAP): EditDiff | null {
  if (!structured || typeof structured !== "object") return null;
  const s = structured as Record<string, unknown>;
  const lines: DiffLine[] = [];
  // structuredPatch hunks: "+x" added, "-x" removed, " x" context, "\ No newline…" marker
  if (Array.isArray(s.structuredPatch)) {
    for (const hunk of s.structuredPatch) {
      const hl = hunk && typeof hunk === "object" ? (hunk as Record<string, unknown>).lines : null;
      if (!Array.isArray(hl)) continue;
      for (const l of hl) {
        if (typeof l !== "string") continue;
        if (l.startsWith("+")) lines.push({ kind: "add", text: l.slice(1) });
        else if (l.startsWith("-")) lines.push({ kind: "del", text: l.slice(1) });
      }
    }
  }
  // Write of a new file: an empty patch and the whole content, every line an addition
  if (lines.length === 0 && typeof s.content === "string" && s.content !== "") {
    const body = s.content.endsWith("\n") ? s.content.slice(0, -1) : s.content;
    for (const l of body.split("\n")) lines.push({ kind: "add", text: l.endsWith("\r") ? l.slice(0, -1) : l });
  }
  if (lines.length === 0) return null;
  let added = 0;
  for (const l of lines) if (l.kind === "add") added++;
  return { shown: lines.slice(0, cap), rest: lines.slice(cap), added, removed: lines.length - added };
}
