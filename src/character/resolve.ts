// Which character a tab shows. Order: the tab's model, then its role, then its agent, then
// vidar.json `characters.default`. Keys are trimmed and lowercased on both sides. When two
// packs claim one key, the earlier in `characters.order` (the list order) wins and
// `findClashes` names it for Settings › Characters. A match on a pack that is missing,
// changed or invalid is NOT passed over to the next claimant: the tab shows the placeholder.
// Pure, type-only imports: tests/character-resolve.test.mjs runs it under node --test.
import type { CharacterEntry, CharacterId, CharacterList, Claim, ClaimKind } from "./catalog";

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The one way a string becomes a CharacterId. */
function asCharacterId(raw: unknown): CharacterId | null {
  return typeof raw === "string" && ID.test(raw) ? raw as CharacterId : null;
}

export function normaliseKey(key: string | null | undefined): string {
  return (key ?? "").trim().toLowerCase();
}

export interface TabIdentity { agent?: string | null; model?: string | null; role?: string | null }

export interface Resolution {
  /** The matched pack's id, or null when nothing matched (no packs, no default). */
  id: CharacterId | null;
  entry: CharacterEntry | null;
  /** True only for a matched pack whose status is ok; anything else shows the placeholder. */
  usable: boolean;
}

const KINDS: ClaimKind[] = ["model", "role", "agent"];

/** The claims a row holds: a valid pack's, or an invalid pack's whose id and answersTo
 *  still parse (Rust sends those as `entry.answersTo`). A row with no id claims nothing. */
export function claimsOf(entry: CharacterEntry): Claim[] {
  if (!entry.id) return [];
  return entry.pack?.answersTo ?? entry.answersTo ?? [];
}

/** First claimant per `kind:key`, in list order. An invalid pack keeps its claims reserved. */
function claimants(list: CharacterList): Map<string, CharacterEntry> {
  const map = new Map<string, CharacterEntry>();
  for (const entry of list.packs) {
    for (const claim of claimsOf(entry)) {
      const key = `${claim.kind}:${normaliseKey(claim.key)}`;
      if (!map.has(key)) map.set(key, entry);
    }
  }
  return map;
}

export function resolveCharacter(list: CharacterList | null, tab: TabIdentity | null): Resolution {
  const none: Resolution = { id: null, entry: null, usable: false };
  if (!list) return none;
  const byKey = claimants(list);
  let entry: CharacterEntry | undefined;
  for (const kind of KINDS) {
    const key = normaliseKey(tab?.[kind]);
    if (key && (entry = byKey.get(`${kind}:${key}`))) break;
  }
  entry ??= list.default ? list.packs.find((p) => p.id === list.default) : undefined;
  const id = entry ? asCharacterId(entry.id) : null;
  if (!entry || !id) return none;
  return { id, entry, usable: entry.status === "ok" && !!entry.pack };
}

export interface Clash { kind: ClaimKind; key: string; winner: string; losers: string[] }

/** Every key more than one pack claims; `winner` is the one resolution uses. */
export function findClashes(list: CharacterList): Clash[] {
  const seen = new Map<string, Clash>();
  for (const entry of list.packs) {
    const mine = new Set<string>();
    const id = entry.id;
    if (!id) continue;
    for (const claim of claimsOf(entry)) {
      const key = normaliseKey(claim.key);
      const slot = `${claim.kind}:${key}`;
      if (mine.has(slot)) continue;
      mine.add(slot);
      const clash = seen.get(slot);
      if (!clash) seen.set(slot, { kind: claim.kind, key, winner: id, losers: [] });
      else clash.losers.push(id);
    }
  }
  return [...seen.values()].filter((c) => c.losers.length > 0);
}
