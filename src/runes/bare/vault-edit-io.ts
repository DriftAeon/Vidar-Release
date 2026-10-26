// src\runes\bare\vault-edit-io.ts — vault-edit.ts's calls bound to IPC for one tab (run 2026-10-25-rune-vault, L3b2):
// the Runes panel's Modify and the Rendered guard-refusal card share it.
import { invoke } from "../../ipc";
import type { VaultView } from "./cake";
import type { VaultEditIo } from "./vault-edit";

/** `rune_vault_read` (no hash: the vault as it is now), `rune_vault_edit`, `rune_vault_session_move` for `tab`, and
 *  the tab's fresh respawn when it has a Rendered body. */
export function tabVaultEditIo(tab: string, respawn?: () => Promise<void>): VaultEditIo {
  return {
    current: (id) => invoke("rune_vault_read", { id }).then((v) => v.vault),
    currentView: (id) => invoke("rune_vault_read", { id }) as Promise<VaultView>,
    edit: (a) => invoke("rune_vault_edit", a),
    moveTab: (id) => invoke("rune_vault_session_move", { tab, id }).then((r) => r !== null),
    ...(respawn ? { respawn } : {}),
  };
}
