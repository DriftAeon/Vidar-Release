// src\runes\bare\gen-label.ts — the readable name of a generated rune library (moved out of view.ts, which
// re-exports it, to keep that module under its size line).
import { label } from "../../format";
import { idLabel } from "./row-name";

const GEN_PRODUCE = ["Apple", "Pear", "Plum", "Peach", "Cherry", "Grape", "Lemon", "Lime", "Mango", "Melon", "Fig", "Kiwi",
  "Olive", "Apricot", "Carrot", "Pea", "Bean", "Leek", "Onion", "Turnip", "Radish", "Beet", "Kale", "Celery", "Pepper",
  "Potato", "Tomato", "Corn", "Garlic", "Cabbage", "Lettuce", "Pumpkin"];

/** Readable name for a generated library id `gen-<rowKey>-<8 hex>` (Runes-Agent-Bare-Surface-Produce), or null when the id has another shape. */
export function genLabel(library: string): string | null {
  const m = /^gen-(.+)-([0-9a-f]{8})$/.exec(library);
  if (!m) return null;
  const toks = m[1].split("-").filter(Boolean);
  if (toks.length < 2 || toks[toks.length - 1] !== "bare") return null;
  const [agent, ...rest] = toks.slice(0, -1);
  const produce = GEN_PRODUCE[parseInt(m[2], 16) % GEN_PRODUCE.length];
  return ["Runes", label(agent), "Bare", ...rest.map((t) => label(t)), produce].join("-");
}

/** How a library name reads: a generated one by genLabel, any other in Title Case (idLabel;
 *  as the Runes view heads it, view.ts); the name on disk is untouched. */
export function libraryLabel(library: string): string {
  return genLabel(library) ?? idLabel(library);
}
