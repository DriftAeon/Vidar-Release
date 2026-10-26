// src\runes\bare\row-name.ts — the name and path a skill, agent or hook file row shows in the Bare Runes view:
// a bold human name on the left, the full path as dim mono subtext on the right. Raw hook rows
// show the safe event, matcher and program label only. Rune rows (rules and memory
// libraries, MCP servers) keep their own names and are not touched.
import type { BareLocalFile } from "./flow";

// Small words stay lowercase after the first word (copied from tools/ui/lint-copy-note.mjs SMALL; src/ never imports tools/).
const SMALL = new Set(["a", "an", "the", "and", "or", "nor", "but", "of", "to", "in", "on", "for", "at", "by", "vs", "via", "per", "as", "from", "with"]);
const EXT = /\.(mjs|cjs|js|ts|md|toml|json|ps1|sh|py)$/i;

/** Pure: whether a row is a path-backed skill, agent or hook file (the rows that show name + path). */
export const isFileRow = (f: Pick<BareLocalFile, "kind">): boolean => f.kind === "skill" || f.kind === "agent" || f.kind === "hook";

/** Pure: a file's human name. `guard-install.mjs` → Guard Install, folder `adversarial-diff-review` → Adversarial Diff Review,
 *  `Striker-O.md` → Striker O. A skill's `SKILL.md` names its folder. */
export function fileName(path: string): string {
  const segs = path.split(/[\\/]/).filter(Boolean);
  let last = segs.pop() ?? path;
  if (/^skill\.md$/i.test(last) && segs.length) last = segs.pop()!;
  return nameLabel(last.replace(EXT, "")) || last;
}

/** Pure: an id in Title Case, no path or extension handling. `kit-mine` → Kit Mine, `kit` → Kit.
 *  camelCase splits too: openaiDeveloperDocs → Openai Developer Docs. Empty when the id holds no word. */
export function nameLabel(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_\s]+/).filter(Boolean);
  return words
    .map((w, i) => (i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** The text a tick row shows: an MCP server id in the same Title Case skills get (`vidar-control` → Vidar Control);
 *  the raw id stays in the row's title. */
export const rowLabel = (f: Pick<BareLocalFile, "kind" | "shown">): string => (f.kind === "mcp" ? fileName(f.shown) : f.shown);

/** The row's two spans: a bold name, then the right-aligned dim mono detail. */
export function nameAndDetail(label: string, detail: string): HTMLElement[] {
  const name = document.createElement("span");
  name.className = "rp-name";
  name.textContent = label;
  const path = document.createElement("span");
  path.className = "rp-path";
  path.textContent = detail;
  return [name, path];
}

/** A file row's name and path, or only the safe label of a raw hook reference. */
export function nameAndPath(f: Pick<BareLocalFile, "path" | "kind" | "shown" | "guard">): HTMLElement[] {
  if (f.kind === "hook" && f.guard?.source) {
    const name = document.createElement("span");
    name.className = "rp-name";
    name.textContent = f.shown;
    return [name];
  }
  return nameAndDetail(fileName(f.path), f.path);
}
