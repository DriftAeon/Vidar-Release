// Release check policy (src-tauri/src/release_check.rs is the fetch and the decision; its header pins
// the wire format): the launch gate, the call's input from state, the state written back, and the
// rows the startup card shows. Pure, type-only imports: node tests load it directly.
import type { CliUpdate } from "./core";

export interface ReleaseAsset { url: string; sha256: string }
export interface CoreOffer { installed: string; version: string; page: string; asset: ReleaseAsset | null }
export interface PackOffer { id: string; label: string; installed: string | null; release: string; page: string }
export interface PackBlocked { id: string; label: string; installed: string | null; release: string; reason: string }
export type ReleaseReply =
  | { status: "ok"; core: CoreOffer | null; packs: PackOffer[]; blocked: PackBlocked[]; seen: Record<string, string> }
  | { status: "offline" | "notPublished" | "error"; reason: string };

/** One startup-card row: the CliUpdate shape the shared renderer takes, plus the page to open and,
 *  for a pack this core cannot take, the reason that disables Open Release. */
export interface ReleaseRow extends CliUpdate { page: string; skipKey: string; blocked: string | null }

export const DAY_MS = 24 * 60 * 60 * 1000;
const SEEN = "packUpdates.seen.";
const PACK_SKIP = "packUpdates.skip.";

/** Launch only: not when `vidarUpdate.atLaunch` is false, and at most once per 24 h. */
export function launchCheckDue(state: Record<string, unknown>, now: number): boolean {
  if (state["vidarUpdate.atLaunch"] === false) return false;
  const last = state["vidarUpdate.lastCheck"];
  return typeof last !== "number" || !Number.isFinite(last) || now - last >= DAY_MS || now < last;
}

export function checkInput(state: Record<string, unknown>): { skip: string | null; seen: Record<string, string> } {
  const skip = state["vidarUpdate.skip"];
  const seen: Record<string, string> = {};
  for (const [k, v] of Object.entries(state)) if (k.startsWith(SEEN) && typeof v === "string") seen[k.slice(SEEN.length)] = v;
  return { skip: typeof skip === "string" ? skip : null, seen };
}

/** State written after a check that reached GitHub: the time and the seen releases. A check that
 *  never reached it (offline, transport error) writes nothing, so the next launch tries again. */
export function statePatch(reply: ReleaseReply, now: number): Record<string, unknown> {
  if (reply.status === "notPublished") return { "vidarUpdate.lastCheck": now };
  if (reply.status !== "ok") return {};
  const entries: Record<string, unknown> = { "vidarUpdate.lastCheck": now };
  for (const [id, release] of Object.entries(reply.seen)) entries[`${SEEN}${id}`] = release;
  return entries;
}

/** Card rows: Vidar first, then pack offers and blocked packs; a pack release the user skipped
 *  (`packUpdates.skip.<id>`) is left out. */
export function releaseRows(reply: ReleaseReply, state: Record<string, unknown>): ReleaseRow[] {
  if (reply.status !== "ok") return [];
  const rows: ReleaseRow[] = [];
  if (reply.core) {
    const c = reply.core;
    rows.push({ id: "vidar", label: `Vidar ${c.version}`, installed: c.installed, latest: c.version, page: c.page, skipKey: "vidarUpdate.skip", blocked: null });
  }
  const packs = [
    ...reply.packs.map((p) => ({ ...p, reason: null as string | null })),
    ...reply.blocked.map((b) => ({ ...b, page: "" })),
  ];
  for (const p of packs) {
    if (state[`${PACK_SKIP}${p.id}`] === p.release) continue;
    rows.push({ id: `pack:${p.id}`, label: `${p.label} ${p.release}`, installed: p.installed ?? "—", latest: p.release,
      page: p.page, skipKey: `${PACK_SKIP}${p.id}`, blocked: p.reason });
  }
  return rows;
}
