// src\runes\bare\vault-edit.ts — the one write path Modify has into a Rune Vault.
// Every edit is `rune_vault_edit({id, ops, mode})`. An open vault takes mode `unlocked`. A locked vault is never
// edited until the user picks: Make Variant (mode `variant`: a new vault id for new sessions only; this tab keeps the
// vault it loaded) or Edit Original (mode `invalidate`: earlier sessions on it become invalid). The first message can lock the vault between
// the read and the edit (D-d); the store then refuses the unlocked edit, and the choice is asked instead.
// `choiceCard` builds on the Rendered notice action card (notice-actions.ts `card`).
import type { Vault, VaultOp } from "../../ipc";
import type { VaultIo } from "./vault-io";
import { card } from "../../panels/rendered/notice-actions";
import { errText } from "../../err-text";

export const MAKE_VARIANT_LABEL = "Make Variant";
export const EDIT_ORIGINAL_LABEL = "Edit Original";
export const EDIT_ORIGINAL_NOTE = "Earlier sessions on this vault become invalid.";
/** Modify's choice card adds this: Edit Original respawns the tab on the edited vault (`settleEdit`). */
export const EDIT_ORIGINAL_RESTART = "Edit Original restarts this tab on the edited vault.";

/** The one notice a Make Variant leaves on the tab; `name` is the variant's name as Pick Vault lists it. */
export const variantSavedNotice = (name: string): string => `Saved as ${name}. New sessions can pick it.`;

export type VaultPick = "variant" | "invalidate";
export type VaultEditMode = "unlocked" | VaultPick;

/** The vault calls an edit makes (vault-io.ts): `read` without a hash is the vault as it is now, not the revision
 *  the session loaded, and is what Modify draws. */
export type VaultEditIo = Pick<VaultIo, "read" | "edit" | "respawn">;

export type EditOutcome =
  | { kind: "edited"; mode: VaultEditMode; vault: Vault }
  | { kind: "ask" }
  | { kind: "failed"; error: string };

const message = errText;

async function lockedNow(io: VaultEditIo, id: string): Promise<boolean> {
  return !!(await io.read(id)).vault.lockedUtc;
}

/** Applies `ops` to vault `id`. Without `pick` it never sends anything but `unlocked`, and only to a vault it just
 *  read as open; a locked vault (read before, or refused by the store's lock check after) answers `ask`. With a pick
 *  it sends that mode as is: the caller only passes one the user clicked. */
export async function editVault(io: VaultEditIo, id: string, ops: VaultOp[], pick?: VaultPick): Promise<EditOutcome> {
  if (pick) {
    try { return { kind: "edited", mode: pick, vault: await io.edit({ id, ops, mode: pick }) }; }
    catch (e) { return { kind: "failed", error: message(e) }; }
  }
  try { if (await lockedNow(io, id)) return { kind: "ask" }; }
  catch (e) { return { kind: "failed", error: message(e) }; }
  try { return { kind: "edited", mode: "unlocked", vault: await io.edit({ id, ops, mode: "unlocked" }) }; }
  catch (e) {
    try { if (await lockedNow(io, id)) return { kind: "ask" }; } catch { /* the edit's own error says more */ }
    return { kind: "failed", error: message(e) };
  }
}

/** What follows a landed edit for this tab. Variant: nothing; the variant is a new vault for new sessions and this
 *  tab keeps the vault it loaded (no session move, no respawn). Unlocked: nothing has been sent yet (an open vault
 *  has no first message), so a fresh respawn loads the edit. Invalidate (Edit Original, L3d): the vault was rewritten in place, so a fresh respawn loads the new
 *  revision as `unlocked` does; other tabs on the vault keep the revision they loaded. */
export async function settleEdit(io: VaultEditIo, done: { mode: VaultEditMode; vault: Vault }): Promise<void> {
  if (done.mode === "variant") return;
  await io.respawn?.();
}

/** The locked-vault choice on the Rendered notice action card (rendered.css `.blk-notice-card`) with the Sheen Cap
 *  buttons: the note, then Make Variant (primary) and Edit Original. A click runs `pick` with its button busy;
 *  a failure shows on the card's error line and the button stays clickable. Nothing is written before a click. */
export function choiceCard(pick: (p: VaultPick) => Promise<void>, text = EDIT_ORIGINAL_NOTE): HTMLElement {
  const { root, acts, error } = card(text);
  root.classList.add("runes-vault-choice");
  const button = (label: string, busy: string, primary: boolean, p: VaultPick): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "wb-card-btn wb-card-btn-primary notice-trust" : "wb-card-btn";
    b.textContent = label;
    b.addEventListener("click", () => {
      if (acts.querySelector("[aria-busy=true]")) return;
      b.classList.remove("is-error");
      error(null);
      b.setAttribute("aria-busy", "true");
      b.textContent = busy;
      pick(p).then(
        () => { b.removeAttribute("aria-busy"); b.textContent = label; },
        (e) => {
          b.removeAttribute("aria-busy");
          b.textContent = label;
          b.classList.add("is-error");
          error(message(e));
        },
      );
    });
    return b;
  };
  acts.append(button(MAKE_VARIANT_LABEL, "Making Variant", true, "variant"), button(EDIT_ORIGINAL_LABEL, "Editing", false, "invalidate"));
  return root;
}
