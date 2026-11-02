// Maps the session's vault revision into the Runes card data.
import type { SetSource, VaultSession, VaultView as VaultRefs } from "../../ipc";
import type { BareActiveBrick, BareSetLayer } from "./flow";
import type { ViewLib } from "./view-types";

/** Pure, the one check before a rune row or card opens its file: `p` as a plain `X:\` path (`/` to `\`, a `\\?\`
 *  prefix dropped), or "" when it is none (empty, relative, UNC, device). The caller then offers no Edit and no
 *  Open Folder instead of an action that fails. */
export function openablePath(p: string | undefined): string {
  const s = (p ?? "").trim().replace(/\//g, "\\").replace(/^\\\\\?\\(?!UNC\\)/i, "");
  return /^[A-Za-z]:\\/.test(s) ? s : "";
}

/** `rune_items::RedactedItem`: a command hook and an MCP rune show `label` only; env shows names only. */
export interface RedactedItem {
  id: string; kind: string; label: string; description: string; agent?: string; requiredByVidar: boolean;
  source?: string; event?: string; matcher?: string; run?: string[]; open?: string[]; allow?: string[]; ask?: string[];
  mode?: string; style?: string; envNames?: string[];
}
/** One rune of a `rune_vault_read` reply; `set` null = a one-off rune; an item rune has an empty body (D-k). `also`:
 *  the other placed runesets that hold it too (it loads once, under `set`). */
export interface VaultViewRune {
  set: SetSource | null; also?: SetSource[]; library: string; id: string; kind: string; activate: string; description: string;
  section: string[]; recall: boolean; body: string; path: string; origin?: string; closesWhen?: string; why?: string; example?: string;
  paths?: string[]; item?: RedactedItem; drift: boolean;
  /** The on slot of the Vidar Runeset that needs this one (it cannot go off while that one is on). */
  neededBy?: string;
  /** A Vidar Runeset slot the shipped set marks required (text runes included). */
  required?: boolean;
}
/** The vault, its drift, the rune list in load order, and the runes left out (missing copy, parse failure). */
export type VaultView = VaultRefs & { runes: VaultViewRune[]; warnings: string[]; off?: VaultViewRune[] };

/** The focused tab's vault as its session loaded it (flow.ts `load`); null = no session record. */
export interface SessionVault { session: VaultSession; view: VaultView }

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
    id: r.id, section: r.section, studs: studs(body), on: true, state: "on", path: openablePath(r.path), kind: r.kind, activate: r.item ? "always" : r.activate,
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
