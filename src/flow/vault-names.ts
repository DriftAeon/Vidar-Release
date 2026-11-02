// The one owner of Rune Vault names for Flow: the `rune_vault_list` fetch, its cache, the ids handed to
// validate.ts, and the repaint hook (`onVaultNames`) the node faces and the card subscribe to. It imports
// neither nodes.ts nor inspector.ts, so both can import it.
//
// One fetch in flight at a time, plus a cache. Flow mount loads once (`loadVaultNames`); a card OPEN
// refreshes (`refreshVaultNames`) so a vault saved since is listed, except the first open after a
// successful mount load, which that load already covers. A render never fetches.

import type { VaultListed } from "../ipc";
import { vaultIpc } from "../runes/bare/vault-io";
import { setLiveVaultIds } from "./validate";
import { vaultRows as pickRows } from "../launcher/start-vault";

let list: VaultListed[] | null = null;
let inflight: Promise<boolean> | null = null;
let primed = false;
const subscribers = new Set<() => void>();

function fetchNames(): Promise<boolean> {
  if (inflight) return inflight;
  inflight = vaultIpc.list().catch((e) => { console.error("flow vault list:", e); return null; })
    .then((all) => {
      if (!all) return false;
      list = all;
      setLiveVaultIds(() => all.map((v) => v.id));
      for (const cb of [...subscribers]) cb();
      return true;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Flow mount: reads the list once and marks it fresh for the first card open. */
export function loadVaultNames(): Promise<boolean> {
  return fetchNames().then((ok) => { primed = ok; return ok; });
}

/** A card opened: reads the list again (one fetch in flight), unless the mount load just did. Resolves
 *  true when the list is usable. */
export function refreshVaultNames(): Promise<boolean> {
  if (inflight) return inflight;
  if (primed) { primed = false; return Promise.resolve(list !== null); }
  return fetchNames();
}

/** True once a list has been read. */
export function vaultsLoaded(): boolean {
  return list !== null;
}

/** The vaults a node can name (by name); empty until the list has loaded. */
export function vaultRows(): VaultListed[] {
  return list ? pickRows(list) : [];
}

/** A vault's display name; its id until the list has loaded or when the id is not listed. */
export function vaultName(id: string): string {
  return list?.find((v) => v.id === id)?.name ?? id;
}

/** Calls `cb` after every successful list read; returns the unsubscribe. */
export function onVaultNames(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}
