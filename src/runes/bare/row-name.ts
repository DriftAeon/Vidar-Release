// src\runes\bare\row-name.ts — the name and path a skill, agent or hook file row shows in the Bare Runes view:
// a bold human name on the left, the full path as dim mono subtext on the right. Raw hook rows
// show the safe event, matcher and program label only. Rune rows (rules and memory
// libraries, MCP servers) keep their own names and are not touched.
import type { BareLocalFile } from "./flow";
import { titleWords } from "../../format";

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

/** An id in Title Case (format.ts titleWords; kept under this name for the Runes callers): `kit-mine` → Kit Mine. */
export const nameLabel = titleWords;

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
