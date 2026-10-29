// src\runes\bare\vault-edit-io.ts — vault-edit.ts's calls bound to IPC for one tab:
// the Runes panel's Modify and the Rendered guard-refusal card share it.
import { invoke } from "../../ipc";
import type { VaultView } from "./cake";
import type { VaultEditIo } from "./vault-edit";

/** `rune_vault_read` (no hash: the vault as it is now) and `rune_vault_edit`, plus the tab's fresh respawn when it has
 *  a Rendered body. `others` runs after an unlocked edit lands, with the vault id, to respawn the other tabs on it
 *  (fire and forget: a failure there never fails the edit). Make Variant never moves the tab's session record. */
export function tabVaultEditIo(_tab: string, respawn?: () => Promise<void>, others?: (vault: string) => Promise<unknown>): VaultEditIo {
  return {
    current: (id) => invoke("rune_vault_read", { id }).then((v) => v.vault),
    currentView: (id) => invoke("rune_vault_read", { id }) as Promise<VaultView>,
    edit: async (a) => {
      const v = await invoke("rune_vault_edit", a);
      if (a.mode === "unlocked" && others) void others(v.id).catch(() => {});
      return v;
    },
    ...(respawn ? { respawn } : {}),
  };
}
