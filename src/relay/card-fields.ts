// Pure parsing for an approval card's field values (relay/card-view.ts draws the result): a value
// splits on " | " into steps, and a Windows path inside a step becomes a chip (dir dim, file bright,
// full path in the tooltip). No DOM here, so the split is unit-tested on its own.

export type Seg = { kind: "text"; text: string } | { kind: "path"; path: string; dir: string; file: string };
export type Step = Seg[];

const PATH = /[A-Za-z]:\\(?:[^\\/:*?"<>|\s]+\\)*[^\\/:*?"<>|\s]*/g;
const TRAIL = /[.,;:!?)\]'"]+$/;
const UNVERIFIED = / \(Unverified\)$/;

/** The path's dir for display: its last two folders behind an ellipsis, ending in a backslash. */
function shortDir(path: string): { dir: string; file: string } {
  const parts = path.split("\\");
  const file = parts.pop() ?? "";
  const folders = parts.slice(1).filter((p) => p !== "");
  if (folders.length === 0) return { dir: `${parts[0]}\\`, file };
  const tail = folders.slice(-2).join("\\");
  return { dir: `${folders.length > 2 ? "…\\" : `${parts[0]}\\`}${tail}\\`, file };
}

function segments(text: string): Seg[] {
  const out: Seg[] = [];
  let at = 0;
  for (const m of text.matchAll(PATH)) {
    const raw = m[0];
    const path = raw.replace(TRAIL, "");
    if (path.length < 4) continue; // a bare drive letter is not a chip
    const start = m.index ?? 0;
    if (start > at) out.push({ kind: "text", text: text.slice(at, start) });
    out.push({ kind: "path", path, ...shortDir(path) });
    at = start + path.length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/** " | " separates steps; each step is text and path chips in order. An empty value is one empty text step. */
export function parseSteps(value: string): Step[] {
  const steps = value.split(" | ").map((s) => s.trim()).filter((s) => s !== "").map(segments);
  return steps.length ? steps : [[{ kind: "text", text: "" }]];
}

/** An asker row carries "(Unverified)" inline; the card shows a separate flag instead. */
export function splitUnverified(value: string): { value: string; unverified: boolean } {
  return UNVERIFIED.test(value) ? { value: value.replace(UNVERIFIED, ""), unverified: true } : { value, unverified: false };
}

const MONO_LABELS = new Set(["Request", "Tool", "Model", "Id", "ID"]);

/** IDs, tool and model names are mono; an Asked By value is mono when it is a bare hex id. */
export function isMonoField(label: string, value: string): boolean {
  if (MONO_LABELS.has(label)) return true;
  return label === "Asked By" && /^[0-9a-f]{6,}$/i.test(value);
}
