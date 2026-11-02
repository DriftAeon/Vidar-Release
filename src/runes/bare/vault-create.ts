// src\runes\bare\vault-create.ts — the one way the UI makes a Rune Vault: `rune_vault_create`. A launch's own copy
// (launcher/start-vault.ts, `name: null`), Save Vault As (vault-save-as.ts) and New Rune Vault (`createFromDraft`)
// all come through `createVault`. Imports only the IPC seam (and vault-io.ts's edit), so the launcher and the Runes view can both use it.
import { invoke } from "../../ipc";
import type { RuneRef, SetSource, Vault, VaultFrom, VaultOp } from "../../ipc";
import { vaultIpc } from "./vault-io";
import { errText } from "../../err-text";

/** `rune_vault_create`'s arguments: `name: null` starts a `copy-*` vault, a name makes a named one; `from: null` starts
 *  from the blank vault (the Vidar Runeset alone). */
export interface VaultCreate { name: string | null; from?: VaultFrom | null; runesets: SetSource[]; runes: RuneRef[]; agent?: string }

export const createVault = (a: VaultCreate): Promise<Vault> => invoke("rune_vault_create", a);

/** What New Rune Vault made: the vault's id, and the edit's error when the vault was made but the staged changes
 *  did not land (the vault exists, so a retry would only meet the store's duplicate-name refusal). */
export interface DraftMade { id: string; error?: string }

export type DraftCreate = (name: string, base: { id: string; hash: string } | null, ops: VaultOp[]) => Promise<DraftMade>;

/** A named vault from `base` at the hash the draft showed (null = the blank vault, the Vidar Runeset alone), then the
 *  draft's staged `ops` as one unlocked edit (a new vault is never locked). Throws the create's refusal (a taken name),
 *  so the name prompt can show it. */
export const createFromDraft: DraftCreate = async (name, base, ops) => {
  const from = base ? { vault: base.id, hash: base.hash } : null;
  const v = await createVault({ name, from, runesets: [], runes: [] });
  if (!ops.length) return { id: v.id };
  try { await vaultIpc.edit({ id: v.id, ops, mode: "unlocked" }); }
  catch (e) { return { id: v.id, error: errText(e) }; }
  return { id: v.id };
};
