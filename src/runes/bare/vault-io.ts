// src\runes\bare\vault-io.ts — the one Rune Vault IO shape the runes UI talks through, and its IPC binding.
// Every consumer takes the slice it calls (`Pick<VaultIo, ...>`: the Runes view, Modify's edit, the vault pick, the
// draft), so a test hands a fake of that slice. `vaultIpc` is the only place the runes UI binds `rune_vault_list`,
// `rune_vault_read`, `rune_vault_lock` and `rune_vault_edit`; `tabVaultIo` adds what is bound to one tab.
import { invoke, type Vault, type VaultListed, type VaultOp, type VaultSession } from "../../ipc";
import type { VaultView } from "./cake";
import type { VaultEditMode } from "./vault-edit";

export interface VaultIo {
  list(): Promise<VaultListed[]>;
  /** `rune_vault_read` at `hash` (the revision a session loaded), or the vault as it is now without one. `id: null` is
   *  the blank vault (the Vidar Runeset alone, never stored). `agent` scopes the view: it holds no rune that agent can't load. */
  read(id: string | null, hash?: string, agent?: string): Promise<VaultView>;
  /** The Lock button's lock, refused when the vault moved past `expectHash`. */
  lock(id: string, expectHash: string): Promise<Vault>;
  edit(a: { id: string; ops: VaultOp[]; mode: VaultEditMode }): Promise<Vault>;
  /** The tab's session record; null when it has none. */
  session(): Promise<VaultSession | null>;
  /** Respawns the tab as a fresh session (the /clear route, D-d); absent when the tab has no Rendered body. */
  respawn?(): Promise<void>;
}

/** The calls bound to no tab. */
export type VaultCalls = Pick<VaultIo, "list" | "read" | "lock" | "edit">;

export const vaultIpc: VaultCalls = {
  list: () => invoke("rune_vault_list"),
  read: (id, hash, agent) => invoke("rune_vault_read", { id, ...(hash ? { hash } : {}), ...(agent ? { agent } : {}) }) as Promise<VaultView>,
  lock: (id, expectHash) => invoke("rune_vault_lock", { id, by: "button", expectHash }),
  edit: (a) => invoke("rune_vault_edit", a),
};

/** One tab's vault IO: `session` reads its record, `respawn` (when it has a Rendered body) starts it fresh, and
 *  `others` runs after an unlocked edit lands, with the vault id, to respawn the other tabs on it (fire and forget:
 *  a failure there never fails the edit). Make Variant never moves the tab's session record. */
export function tabVaultIo(session: VaultIo["session"], respawn?: () => Promise<void>, others?: (vault: string) => Promise<unknown>): VaultIo {
  return {
    ...vaultIpc,
    session,
    edit: async (a) => {
      const v = await vaultIpc.edit(a);
      if (a.mode === "unlocked" && others) void others(v.id).catch(() => {});
      return v;
    },
    ...(respawn ? { respawn } : {}),
  };
}
