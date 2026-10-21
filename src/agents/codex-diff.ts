// Codex fileChange shaping: its `{path, kind, diff}` changes into the line lists the Rendered
// panel draws (approval card, Edit pill). Pure, no DOM; tests import it bare.

export interface CodexChange { path: string; kind: string; diff: string }
export type CodexDiffLine = { kind: "add" | "del"; text: string };

/** the `changes` array of a Codex Edit input/approval; [] when the input is not that shape */
export function codexChanges(input: unknown): CodexChange[] {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>).changes : null;
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    return {
      path: typeof o.path === "string" ? o.path : "",
      kind: typeof o.kind === "string" ? o.kind : "",
      diff: typeof o.diff === "string" ? o.diff : "",
    };
  });
}

/** + and − lines of one change. An added/deleted file carries raw content, an update a unified diff
 *  (file and hunk headers dropped, context dropped). */
export function codexDiffLines(c: { kind: string; diff: string }): CodexDiffLine[] {
  const body = c.diff.endsWith("\n") ? c.diff.slice(0, -1) : c.diff;
  if (body === "") return [];
  const out: CodexDiffLine[] = [];
  const raw = c.kind.startsWith("add") ? "add" : c.kind.startsWith("delete") ? "del" : null;
  for (const l0 of body.split("\n")) {
    const l = l0.endsWith("\r") ? l0.slice(0, -1) : l0;
    if (raw) { out.push({ kind: raw, text: l }); continue; }
    if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("@@")) continue;
    if (l.startsWith("+")) out.push({ kind: "add", text: l.slice(1) });
    else if (l.startsWith("-")) out.push({ kind: "del", text: l.slice(1) });
  }
  return out;
}

/** the Edit pill's `structured` result in the shape edit-diff reads (structuredPatch hunks) */
export function codexStructured(changes: CodexChange[], status: string): Record<string, unknown> {
  const lines: string[] = [];
  for (const c of changes) for (const l of codexDiffLines(c)) lines.push(`${l.kind === "add" ? "+" : "-"}${l.text}`);
  return lines.length ? { status, structuredPatch: [{ lines }] } : { status };
}
