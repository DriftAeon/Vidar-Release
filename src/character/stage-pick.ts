// Stage packs on the wire (`list_stages`, src-tauri\src\stages) and the pure decisions around
// them: which stage the pick resolves to, and whether image bytes are an image. Import-free
// so Node tests load it directly; the Three.js side is stage-pack.ts.

/** `content\stages\<id>\stage.json` as Rust validated it (schema.rs). Data only. */
export interface StageDef {
  id: string;
  label: string;
  release?: string;
  requires?: unknown;
  background: { image?: string; glb?: string };
  /** `#rrggbb`: the clear colour when there is no image, and the fog colour. */
  colour?: string;
  fog?: { near: number; far: number };
  camera?: { far?: number; minDistance?: number; maxDistance?: number };
}

export interface StageEntry {
  /** The folder name when it is a valid id. */
  id: string | null;
  folder: string;
  status: "ok" | "broken";
  reason?: string;
  stage?: StageDef;
}

export interface StageList {
  stages: StageEntry[];
}

/** The part of a stage `read_stage_asset` returns. */
export type StagePart = "image" | "glb";

/** Shown in the Character window when the picked stage cannot be used. */
export const STAGE_FALLBACK_NOTE = "Stage Not Loaded, Showing Default";

export type StageChoice =
  | { kind: "default"; note: string | null }
  | { kind: "pack"; stage: StageDef };

/** vidar.json `characterStage` (untrusted) against the listing. Absent or blank = the default
 *  with no note; a pick that is not listed, is broken, or meets a failed listing (null) falls
 *  back to the default with the note. */
export function chooseStage(pick: unknown, list: StageList | null): StageChoice {
  if (typeof pick !== "string" || !pick.trim()) return { kind: "default", note: null };
  const entry = list?.stages.find((e) => e.id === pick);
  if (!entry || entry.status !== "ok" || !entry.stage) return { kind: "default", note: STAGE_FALLBACK_NOTE };
  return { kind: "pack", stage: entry.stage };
}

/** The camera far plane: never below `current` (the base or the framed-character bound) or the
 *  stage's own far, and always past the furthest orbit plus the character's diameter. */
export function cameraFar(current: number, stageFar: number, maxDistance: number, subjectRadius: number | null): number {
  return Math.max(current, stageFar, maxDistance + (subjectRadius ?? 0) * 2);
}

/** A pack's closest orbit distance, never above its furthest (defaults already applied). */
export function clampMinDistance(minDistance: number, maxDistance: number): number {
  return Math.min(minDistance, maxDistance);
}

/** The MIME type of png, jpg or webp bytes; null for anything else. */
export function imageMime(bytes: ArrayBuffer): string | null {
  const b = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 12));
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}
