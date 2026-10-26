// src\runes\bare\vault-edit.ts — the one write path Modify has into a Rune Vault (run 2026-10-25-rune-vault, L3b2).
// Every edit is `rune_vault_edit({id, ops, mode})`. An open vault takes mode `unlocked`. A locked vault is never
// edited until the user picks: Make Variant (mode `variant`: a new vault id, and this tab moves to it) or Edit
// Original (mode `invalidate`: earlier sessions on it become invalid). The first message can lock the vault between
// the read and the edit (D-d); the store then refuses the unlocked edit, and the choice is asked instead.
// The pure part has type-only imports, so `node --test` loads it; `choiceCard` builds the notice action card.
import type { Vault, VaultOp } from "../../ipc";
import type { VaultView } from "./cake";
import { addToVault, type GeneratedRef } from "./progress";

export const MAKE_VARIANT_LABEL = "Make Variant";
export const EDIT_ORIGINAL_LABEL = "Edit Original";
export const EDIT_ORIGINAL_NOTE = "Earlier sessions on this vault become invalid.";
/** Modify's choice card adds this: Edit Original respawns the tab on the edited vault (`settleEdit`). */
export const EDIT_ORIGINAL_RESTART = "Edit Original restarts this tab on the edited vault.";
const NO_RECORD = "This tab has no vault session to move.";

export type VaultPick = "variant" | "invalidate";
export type VaultEditMode = "unlocked" | VaultPick;

/** The vault calls an edit makes; bound in the Runes panel to `rune_vault_read`, `rune_vault_edit`,
 *  `rune_vault_session_move` and the tab's Rendered body. */
export interface VaultEditIo {
  /** The vault as it is now (not the revision the session loaded). */
  current(id: string): Promise<Vault>;
  /** The current vault's rune view (`rune_vault_read` without a hash), which Modify draws. */
  currentView(id: string): Promise<VaultView>;
  edit(a: { id: string; ops: VaultOp[]; mode: VaultEditMode }): Promise<Vault>;
  /** Moves this tab's session record to vault `id`; false when the tab has no record. */
  moveTab(id: string): Promise<boolean>;
  /** Respawns this tab as a fresh session (the /clear route, D-d); absent when the tab has no Rendered body. */
  respawn?(): Promise<void>;
}

export type EditOutcome =
  | { kind: "edited"; mode: VaultEditMode; vault: Vault }
  | { kind: "ask" }
  | { kind: "failed"; error: string };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function lockedNow(io: VaultEditIo, id: string): Promise<boolean> {
  return !!(await io.current(id)).lockedUtc;
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

/** What follows a landed edit for this tab. Variant: the tab's record moves to the new id, then a fresh respawn
 *  loads it. Unlocked: nothing has been sent yet (an open vault has no first message), so a fresh respawn loads the
 *  edit. Invalidate (Edit Original, L3d): the vault was rewritten in place, so a fresh respawn loads the new
 *  revision as `unlocked` does; other tabs on the vault keep the revision they loaded. Throws on a failed move. */
export async function settleEdit(io: VaultEditIo, done: { mode: VaultEditMode; vault: Vault }): Promise<void> {
  if (done.mode === "variant" && !(await io.moveTab(done.vault.id))) throw new Error(NO_RECORD);
  await io.respawn?.();
}

/** Edit, then settle: `ask` when the user has to pick first; throws the store's or the move's error. */
export async function applyVaultEdit(io: VaultEditIo, id: string, ops: VaultOp[], pick?: VaultPick): Promise<"done" | "ask"> {
  const r = await editVault(io, id, ops, pick);
  if (r.kind === "ask") return "ask";
  if (r.kind === "failed") throw new Error(r.error);
  await settleEdit(io, r);
  return "done";
}

/** Add to Vault on the generate result card: progress.ts `addToVault` makes the unlocked edit on an open vault; a
 *  locked one (before, or the store's refusal after) answers `ask`, and the caller holds `addToVaultOps(r)` for the
 *  choice card. Throws the store's error otherwise; a landed add respawns the tab like any unlocked edit. */
export async function addGeneratedToVault(io: VaultEditIo, id: string, r: GeneratedRef): Promise<"done" | "ask"> {
  if (await lockedNow(io, id)) return "ask";
  const error = await addToVault((a) => io.edit(a), id, r);
  if (error === null) { await io.respawn?.(); return "done"; }
  if (await lockedNow(io, id).catch(() => false)) return "ask";
  throw new Error(error);
}

/** The locked-vault choice on the Rendered notice action card (rendered.css `.blk-notice-card`) with the Sheen Cap
 *  buttons: the note, then Make Variant (primary) and Edit Original. A click runs `pick` with its button busy;
 *  a failure shows on the card's error line and the button stays clickable. Nothing is written before a click. */
export function choiceCard(pick: (p: VaultPick) => Promise<void>, text = EDIT_ORIGINAL_NOTE): HTMLElement {
  const root = document.createElement("div");
  root.className = "blk blk-notice-card runes-vault-choice";
  const body = document.createElement("div");
  body.className = "notice-body";
  const note = document.createElement("div");
  note.className = "blk-notice warn";
  note.textContent = text;
  const err = document.createElement("div");
  err.className = "notice-err";
  err.hidden = true;
  body.append(note, err);
  const acts = document.createElement("div");
  acts.className = "wb-actions notice-acts";
  const button = (label: string, busy: string, primary: boolean, p: VaultPick): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "wb-card-btn wb-card-btn-primary notice-trust" : "wb-card-btn";
    b.textContent = label;
    b.addEventListener("click", () => {
      if (acts.querySelector("[aria-busy=true]")) return;
      b.classList.remove("is-error");
      err.hidden = true;
      b.setAttribute("aria-busy", "true");
      b.textContent = busy;
      pick(p).then(
        () => { b.removeAttribute("aria-busy"); b.textContent = label; },
        (e) => {
          b.removeAttribute("aria-busy");
          b.textContent = label;
          b.classList.add("is-error");
          err.hidden = false;
          err.textContent = message(e);
        },
      );
    });
    return b;
  };
  acts.append(button(MAKE_VARIANT_LABEL, "Making Variant", true, "variant"), button(EDIT_ORIGINAL_LABEL, "Editing", false, "invalidate"));
  root.append(body, acts);
  return root;
}
