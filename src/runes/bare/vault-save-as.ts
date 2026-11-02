// src\runes\bare\vault-save-as.ts — Save Vault As in Modify: an inline Name + Save (Flow's New form shape) that saves
// this tab's vault under a name through `rune_vault_create {name, from: {vault, hash}}`, so Flow and new tabs can pick
// it. The tab stays on its own copy; a "Vault Saved" chip trails the action row. The store's refusal (a duplicate name)
// shows on the error line. An empty name sends nothing: `name: null` would start a copy-* vault.
import type { Vault } from "../../ipc";
import { button, el } from "../../dom";
import type { VaultCreate } from "./vault-create";
import { errText } from "../../err-text";

export const TIP_SAVE_AS = "Saves this tab's vault under a name, so Flow and new tabs can pick it.";

export interface SaveAsState { open: boolean; name: string; saved: boolean; error: string | null }
export const newSaveAsState = (): SaveAsState => ({ open: false, name: "", saved: false, error: null });

/** `createVault` (vault-create.ts); tests hand their own. */
export type VaultCreateCall = (a: VaultCreate) => Promise<Vault>;

export async function saveVaultAs(s: SaveAsState, create: VaultCreateCall, vault: { id: string; hash: string }): Promise<void> {
  const name = s.name.trim();
  if (!name) return;
  s.error = null;
  try { await create({ name, from: { vault: vault.id, hash: vault.hash }, runesets: [], runes: [] }); }
  catch (e) { s.error = errText(e); return; }
  Object.assign(s, newSaveAsState(), { saved: true });
}

/** The action row's tail: the Save Vault As button, or the inline form while it is open, then the chip. */
export const TIP_SAVE_AS_HELD = "Done or Cancel this vault's changes first; Save Vault As saves the vault as it is.";

/** `held`: Modify has changes waiting for Done, so Save Vault As (which saves the vault as it is) waits too. */
export function saveAsControls(s: SaveAsState, busy: boolean, run: { toggle(): void; save(): void }, held = false): HTMLElement[] {
  if (!s.open) {
    const b = button("Save Vault As", "ws-btn", run.toggle, busy || held);
    b.title = held ? TIP_SAVE_AS_HELD : TIP_SAVE_AS;
    return [b, ...(s.saved ? [el("span", "runes-chip also", "Vault Saved")] : [])];
  }
  const form = el("span", "runes-saveas");
  const name = el("input", "runes-write-field runes-saveas-name");
  name.type = "text"; name.placeholder = "Name"; name.value = s.name;
  name.setAttribute("aria-label", "Name");
  name.dataset.keep = "saveas-name";
  name.addEventListener("input", () => { s.name = name.value; });
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run.save();
    else if (e.key === "Escape") run.toggle();
  });
  const save = button("Save", "ws-btn", run.save, busy || held);
  if (held) save.title = TIP_SAVE_AS_HELD;
  form.append(name, save);
  if (s.error) form.appendChild(el("span", "rp-error", s.error));
  return [form];
}
