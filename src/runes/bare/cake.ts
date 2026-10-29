// Maps the session's vault revision into the Runes card data.
import type { SetSource, Vault, VaultSession, VaultView as VaultRefs } from "../../ipc";
import type { BareActiveBrick, BareSetLayer } from "./flow";
import type { ViewLib } from "./view-types";

/** `rune_items::RedactedItem`: a command hook and an MCP rune show `label` only; env shows names only. */
export interface RedactedItem {
  id: string; kind: string; label: string; description: string; agent?: string; requiredByVidar: boolean;
  source?: string; event?: string; matcher?: string; run?: string[]; open?: string[]; allow?: string[]; ask?: string[];
  mode?: string; style?: string; envNames?: string[];
}
/** One rune of a `rune_vault_read` reply; `set` null = a one-off rune; an item rune has an empty body (D-k). */
export interface VaultViewRune {
  set: SetSource | null; library: string; id: string; kind: string; activate: string; description: string;
  section: string[]; recall: boolean; body: string; origin?: string; closesWhen?: string; why?: string; example?: string;
  paths?: string[]; item?: RedactedItem; drift: boolean;
}
/** The vault, its drift, the rune list in load order, and the runes left out (missing copy, parse failure). */
export type VaultView = VaultRefs & { runes: VaultViewRune[]; warnings: string[]; off?: VaultViewRune[] };

/** The vault calls the View makes (bound to `rune_vault_session`, `rune_vault_read`, `rune_vault_lock`). */
export interface VaultIo {
  session(): Promise<VaultSession | null>;
  read(id: string, hash: string): Promise<VaultView>;
  lock(id: string, expectHash: string): Promise<Vault>;
}

/** The focused tab's vault as its session loaded it; null = no session record. */
export interface SessionVault { session: VaultSession; view: VaultView }

/** Reads the tab's session record, then the vault at the hash that session loaded. */
export async function readSessionVault(io: VaultIo): Promise<SessionVault | null> {
  const session = await io.session();
  if (!session) return null;
  return { session, view: await io.read(session.vault.id, session.vault.hash) };
}

/** A vault brick: a library brick plus whether the library rune changed since lock (D-e). */
export type VaultBrick = BareActiveBrick & { drift?: boolean };
export const driftOf = (b: object): boolean => (b as VaultBrick).drift === true;

/** Pure: an item rune's card body from its redacted view; a command hook and an MCP rune show the label only. */
export function itemBody(i: RedactedItem): string {
  const list = (name: string, xs?: string[]): string[] => (xs?.length ? [`${name}: ${xs.join(", ")}`] : []);
  return [i.label, ...(i.event ? [`Event: ${i.event}`] : []), ...(i.matcher ? [`Matcher: ${i.matcher}`] : []),
    ...(i.source ? [`Source: ${i.source}`] : []), ...list("Run", i.run), ...list("Open", i.open), ...list("Allow", i.allow),
    ...list("Ask", i.ask), ...(i.mode ? [`Mode: ${i.mode}`] : []), ...(i.style ? [`Style: ${i.style}`] : []), ...list("Env", i.envNames)].join("\n\n");
}

const studs = (body: string): number => Math.max(3, Math.ceil([...body].length / 25));

function vaultBrick(r: VaultViewRune): VaultBrick {
  const body = r.item ? itemBody(r.item) : r.body;
  return {
    id: r.id, section: r.section, studs: studs(body), on: true, state: "on", path: "", kind: r.kind, activate: r.item ? "always" : r.activate,
    description: r.description, body, origin: r.origin, closesWhen: r.closesWhen, why: r.why, example: r.example, paths: r.paths, drift: r.drift,
  };
}

// Card helpers still consume a set shell; item content comes from the vault rune list.
const layerStub = (set: string): BareSetLayer => ({ set });

/** Pure: the vault's runes as library cards, one per library in first-seen order. A runeset's runes go to its own
 *  library's card (cross-library slots included); recall members are its On Demand list; a one-off joins its
 *  library's card. Nothing here reads a launcher row. */
export function vaultLibraries(view: { runes: readonly VaultViewRune[] }): ViewLib[] {
  const libs = new Map<string, ViewLib>();
  for (const r of view.runes) {
    const name = r.set ? r.set.library : r.library;
    let lib = libs.get(name);
    if (!lib) libs.set(name, lib = { library: name, source: null, scope: "global", sourceGone: false, bricks: [], sets: [], onDemand: [] });
    if (r.set && !lib.sets!.some((s) => s.set === r.set!.set)) lib.sets!.push(layerStub(r.set.set));
    (r.recall ? lib.onDemand! : lib.bricks).push(vaultBrick(r));
  }
  return [...libs.values()];
}

/** The panel caches one mounted view per tab. */
export const bareViewKey = (tabId: string): string => `tab|${tabId}`;
