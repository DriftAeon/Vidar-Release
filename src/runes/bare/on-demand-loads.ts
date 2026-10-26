// Transcript Read paths are matched to On Demand brick paths; Skill calls need an explicit
// skill-to-rune mapping from actives before they can mark a brick as loaded.
import { normPath } from "../trace";

export const readSet = (paths: readonly string[] = []): ReadonlySet<string> => new Set(paths.map(normPath));

// A Bare rune read through its `vidar-runes/<id>.md` skill copy (loaded.rs `runeReads`) joins the read set by id.
const RUNE_READ = "rune:";
export const readKeys = (res: { reads?: string[]; runeReads?: string[] } | null): string[] =>
  [...(res?.reads ?? []), ...(res?.runeReads ?? []).map((id) => RUNE_READ + id)];

export function wasRead(
  reads: ReadonlySet<string>, brick: { id: string; path: string }, skills: readonly string[] = [],
  skillRunes: ReadonlyMap<string, readonly string[]> = new Map(),
): boolean {
  if (brick.path && reads.has(normPath(brick.path))) return true;
  if (reads.has(normPath(RUNE_READ + brick.id))) return true;
  return skills.some((skill) => skillRunes.get(skill)?.includes(brick.id) ?? false);
}
