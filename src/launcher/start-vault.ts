// The vault a fresh Bare launch actually loads. A session never shares a vault with another tab: a copy or legacy
// Custom source starts a new `copy-*` vault (Rust `rune_vault_create`, name null, `from` = the source and its hash); a
// named vault passes through. A resume names the recorded vault and loads it as it is. Last Vault keeps the source id;
// only the tab holds the copy.
// Also the vault list a row offers (`vaultRows`: the Runes panel's vault pick and Flow's vault names).
import type { VaultListed } from "../ipc";
import { createVault } from "../runes/bare/vault-create";
import { vaultIpc } from "../runes/bare/vault-io";

/** Ids that start a copy on a fresh launch (a `custom-*` is a legacy Custom vault, hidden like a copy). */
export const startsCopy = (id: string): boolean => /^(copy|custom)-/.test(id);

/** Ids the vault list hides: copies and legacy Custom vaults are never cards. */
export const hiddenVault = (id: string): boolean => id.startsWith("copy-") || id.startsWith("custom-");

/** Pure: the vaults a row offers, saved vaults by name. Vaults are agent-neutral; each read scopes its runes to the agent. */
export function vaultRows(list: readonly VaultListed[]): VaultListed[] {
  const seen = new Set<string>();
  return list.filter((v) => {
    if (hiddenVault(v.id)) return false; // a copy is a tab's own vault, a legacy Custom one is no card
    if (seen.has(v.id)) return false;
    seen.add(v.id);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** The vault id a launch of `agent` loads. `recorded`: `vault` came from a session record (a resume), so it is kept.
 *  A source that can no longer be read is the launch error. */
export async function startVault(agent: string, vault: string, recorded = false): Promise<string> {
  if (recorded || !startsCopy(vault)) return vault;
  const hash = (await vaultIpc.read(vault, undefined, agent)).vault.hash;
  const made = await createVault({ name: null, from: { vault, hash }, runesets: [], runes: [], agent });
  return made.id;
}
