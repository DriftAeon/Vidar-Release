// Run names: a run keeps one short word for life, derived from its id at render time (FNV-1a hash ->
// index) and never stored. Leaf module (no imports) so node --test loads it.

/** 64 short, neutral Title Case nouns: trees, stones, birds. Order is part of the name: append, never reorder. */
export const RUN_WORDS: readonly string[] = [
  "Juniper", "Alder", "Birch", "Cedar", "Elm", "Hazel", "Larch", "Maple", "Willow", "Rowan", "Aspen",
  "Poplar", "Spruce", "Holly", "Linden", "Hickory", "Cypress", "Beech", "Yew", "Laurel", "Chestnut", "Sycamore",
  "Granite", "Basalt", "Quartz", "Slate", "Flint", "Marble", "Obsidian", "Jasper", "Agate", "Onyx", "Garnet",
  "Opal", "Pumice", "Shale", "Gneiss", "Schist", "Topaz", "Beryl", "Cobble", "Limestone", "Feldspar",
  "Heron", "Wren", "Finch", "Swift", "Plover", "Kestrel", "Osprey", "Sparrow", "Thrush", "Curlew", "Lark",
  "Egret", "Merlin", "Tern", "Pipit", "Starling", "Magpie", "Linnet", "Robin", "Harrier", "Dunlin",
];

export function runWord(runId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < runId.length; i++) h = Math.imul(h ^ runId.charCodeAt(i), 0x01000193) >>> 0;
  return RUN_WORDS[h % RUN_WORDS.length];
}

/** `Juniper 18 Oct 12:51 pm`: the word, then the locale date and time joined by spaces (no comma, no status). */
export function runLabel(runId: string, startedAt: string): string {
  const d = new Date(startedAt);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" }).replaceAll(",", "");
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${runWord(runId)} ${date} ${time}`;
}
