// src\runes\bare\gen-label.ts — the readable name of a generated rune library (moved out of view.ts, which
// re-exports it, to keep that module under its size line; run 2026-10-20-rune-sets, W4).
import { nameLabel } from "./row-name";

const GEN_PRODUCE = ["Apple", "Pear", "Plum", "Peach", "Cherry", "Grape", "Lemon", "Lime", "Mango", "Melon", "Fig", "Kiwi",
  "Olive", "Apricot", "Carrot", "Pea", "Bean", "Leek", "Onion", "Turnip", "Radish", "Beet", "Kale", "Celery", "Pepper",
  "Potato", "Tomato", "Corn", "Garlic", "Cabbage", "Lettuce", "Pumpkin"];

/** Whether `library` is `gen-<rowKey>-<8 lowercase hex>` (mirrors `is_generation_of` in src-tauri/src/rules/generate/land.rs). */
export function isGenerationOf(library: string, rowKey: string): boolean {
  const p = `gen-${rowKey}-`;
  return library.startsWith(p) && /^[0-9a-f]{8}$/.test(library.slice(p.length));
}

/** Readable name for a generated library id `gen-<rowKey>-<8 hex>` (Runes-Agent-Bare-Surface-Produce), or null when the id has another shape. */
export function genLabel(library: string): string | null {
  const m = /^gen-(.+)-([0-9a-f]{8})$/.exec(library);
  if (!m) return null;
  const toks = m[1].split("-").filter(Boolean);
  if (toks.length < 2 || toks[toks.length - 1] !== "bare") return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const [agent, ...rest] = toks.slice(0, -1);
  const produce = GEN_PRODUCE[parseInt(m[2], 16) % GEN_PRODUCE.length];
  return ["Runes", cap(agent), "Bare", ...rest.map(cap), produce].join("-");
}

/** How a library name reads: a generated one by genLabel, any other in Title Case (nameLabel;
 *  as the Runes view heads it, view.ts); the name on disk is untouched. */
export function libraryLabel(library: string): string {
  return genLabel(library) ?? (nameLabel(library) || library);
}
