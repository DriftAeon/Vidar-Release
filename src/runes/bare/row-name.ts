// src\runes\bare\row-name.ts — the name and path a skill, agent or hook file row shows in the Bare Runes view:
// a bold human name on the left, the full path as dim mono subtext on the right. Rune rows (rules and memory
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
  const words = last.replace(EXT, "").split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return last;
  return words
    .map((w, i) => (i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** The row's two spans: the bold name, then the right-aligned path. The full path also goes in the row's title. */
export function nameAndPath(f: Pick<BareLocalFile, "path">): HTMLElement[] {
  const name = document.createElement("span");
  name.className = "rp-name";
  name.textContent = fileName(f.path);
  const path = document.createElement("span");
  path.className = "rp-path";
  path.textContent = f.path;
  return [name, path];
}
