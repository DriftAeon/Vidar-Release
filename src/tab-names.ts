// src\tab-names.ts — themed tab names ("Amber Raptor") and the one resolver that
// maps a tab address (id or name) to a tab id. Pure: no DOM, no imports.
// Falcon, Astra, Hound, Striker, Orion, Relay and Liger are left out of the lists
// on purpose: they already name Vidar things.

export const TAB_DESCRIPTORS = [
  "Amber", "Cobalt", "Crimson", "Iron", "Onyx", "Ivory", "Storm", "Ember", "Frost", "Thunder", "Shadow", "Solar",
  "Lunar", "Rust", "Titan", "Steel", "Nova", "Vector", "Static", "Pulse", "Halo", "Graphite", "Arc", "Gale",
] as const;

export const TAB_NOUNS = [
  "Raptor", "Sabre", "Mantis", "Hornet", "Kodiak", "Wyvern", "Jackal", "Talon", "Bastion", "Sentinel", "Warden", "Lancer",
  "Ronin", "Valkyrie", "Golem", "Basilisk", "Griffin", "Hydra", "Manta", "Scorpion", "Rhino", "Panther", "Coyote", "Viper",
] as const;

const pick = <T>(list: readonly T[], rand: () => number): T => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

/** A "<Descriptor> <Noun>" no open tab's title uses (case-insensitive). When all 576 pairs are
 *  taken, a random pair gets " 2", " 3"... appended until it is free. `rand` is injectable for tests. */
export function mintTabName(openTitles: Iterable<string>, rand: () => number = Math.random): string {
  const taken = new Set<string>();
  for (const t of openTitles) taken.add(t.trim().toLowerCase());
  const free: string[] = [];
  for (const d of TAB_DESCRIPTORS) for (const n of TAB_NOUNS) if (!taken.has(`${d} ${n}`.toLowerCase())) free.push(`${d} ${n}`);
  if (free.length) return pick(free, rand);
  const base = `${pick(TAB_DESCRIPTORS, rand)} ${pick(TAB_NOUNS, rand)}`;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** A tab address to a tab id: an exact id first, then a case-insensitive exact title match.
 *  Zero or several title matches give null, which fails the way an unknown id does. */
export function resolveTabRef(tabs: readonly { id: string; title: string }[], ref: string): string | null {
  if (tabs.some((t) => t.id === ref)) return ref;
  const want = ref.trim().toLowerCase();
  if (!want) return null;
  const hits = tabs.filter((t) => t.title.trim().toLowerCase() === want);
  return hits.length === 1 ? hits[0].id : null;
}
