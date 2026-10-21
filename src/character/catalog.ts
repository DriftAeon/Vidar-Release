// The runtime character catalogue's types. The data is the
// user's pack folders, listed by Rust (`list_characters`, src-tauri\src\characters\); the
// store is packs.ts, the tab → character mapping resolve.ts. No runtime imports here, so the
// pure modules can import these types under node --test.

/** A pack id: validated (`asCharacterId` in resolve.ts), never a free string. It keys
 *  vidar.json `characterViews`, so it is immutable once a pack exists. */
export type CharacterId = string & { readonly __characterId: unique symbol };

export interface CharacterLighting {
  ambient: number;
  key: number;
  fill: number;
}

export type MaterialPreference = "auto" | "cel" | "standard";
export type ClaimKind = "model" | "role" | "agent";
export interface Claim { kind: ClaimKind; key: string }

/** One `character.json` (src-tauri\src\characters\pack.rs `Pack`). */
export interface CharacterPack {
  id: string;
  name: string;
  model: { path: string; bytes: number; sha256: string };
  material: MaterialPreference;
  lighting?: CharacterLighting;
  playrate?: Record<string, number>;
  answersTo: Claim[];
}

type PackStatus = "ok" | "missing" | "changed" | "invalid";

/** One row of `list_characters`. `pack` is absent when the folder is invalid. */
export interface CharacterEntry {
  /** The id this row holds; null for an unreadable folder or a duplicate id. */
  id: string | null;
  /** What repin/update/remove take: a valid pack's id, else `folder:<name>`. */
  target: string;
  folder: string;
  dir: string;
  status: PackStatus;
  reason?: string;
  currentBytes?: number;
  pack?: CharacterPack;
  /** An invalid pack's claims when its id and answersTo still parse; they stay reserved. */
  answersTo?: Claim[];
}

export interface CharacterList {
  packs: CharacterEntry[];
  default: string | null;
}

/** A pack's lighting, or these defaults (tuned for the cel shader). */
const DEFAULT_LIGHTING: CharacterLighting = { ambient: 0.65, key: 0.4, fill: 0.06 };

export function lightingFor(pack: CharacterPack): CharacterLighting {
  return pack.lighting ?? DEFAULT_LIGHTING;
}
