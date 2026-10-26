// src\runes\bare\vault-modify-state.ts — what the Bare view's Modify holds for a tab's Rune Vault (run
// 2026-10-25-rune-vault, L3b2): the vault as it is now, the runes this Modify took out, and a locked-vault edit
// waiting on Make Variant / Edit Original. Every write goes through vault-edit.ts; nothing touches a launcher row.
import type { VaultOp } from "../../ipc";
import type { VaultView, VaultViewRune } from "./cake";
import { addToVaultOps, type GeneratedRef } from "./progress";
import { addGeneratedToVault, applyVaultEdit, type VaultEditIo, type VaultPick } from "./vault-edit";
import { LOCKED_EDIT_TEXT, type PendingEdit } from "./view-vault";

const NO_VAULT = "This tab has no vault to edit.";

export interface VaultModifyState {
  /** The vault as it is now (read without a hash), which Modify draws and edits; null without a record. */
  now: VaultView | null;
  /** Runes this Modify took out, kept so their switches can put them back. */
  removed: VaultViewRune[];
  pending: PendingEdit | null;
  /** Add Rune's list: the runes this tab's agent can add from its libraries; null while the list is closed. */
  library: VaultViewRune[] | null;
  /** Opens Add Rune's list with what `load` returns, or closes an open one. Throws. */
  toggleLibrary(load: () => Promise<VaultViewRune[]>): Promise<void>;
  /** Leaving Modify drops the pending edit, the taken-out list and Add Rune's list. */
  reset(): void;
  /** Reads vault `id` as it is now; null clears it. */
  read(id: string | null): Promise<void>;
  /** `ops` through the vault edit path; a locked vault (or one locked meanwhile) parks them as `pending`.
   *  `keep` are the runes the ops take out; `add` routes a generated runeset through Add to Vault. Throws. */
  edit(ops: VaultOp[], keep?: VaultViewRune[], add?: GeneratedRef, text?: string): Promise<void>;
  /** Add to Vault for a generated runeset. Throws. */
  addGenerated(r: GeneratedRef): Promise<void>;
  /** The user's pick for the pending edit; throws onto the choice card's error line. */
  pick(p: VaultPick): Promise<void>;
  /** The runes `ops` take out of the vault, so the view can still draw them switched off. */
  takenOut(ops: VaultOp[]): VaultViewRune[];
}

const same = (a: VaultViewRune, b: VaultViewRune): boolean =>
  a.library === b.library && a.id === b.id && JSON.stringify(a.set) === JSON.stringify(b.set);

export function vaultModifyState(io: VaultEditIo | undefined): VaultModifyState {
  const s: VaultModifyState = {
    now: null, removed: [], pending: null, library: null,
    reset() { s.pending = null; s.removed = []; s.library = null; },
    async toggleLibrary(load) { s.library = s.library ? null : await load(); },
    async read(id) { s.now = id && io ? await io.currentView(id) : null; },
    async edit(ops, keep = [], add, text = LOCKED_EDIT_TEXT) {
      if (!s.now || !io) throw new Error(NO_VAULT);
      const id = s.now.vault.id;
      if (await (add ? addGeneratedToVault(io, id, add) : applyVaultEdit(io, id, ops)) === "ask") { s.pending = { ops, text }; return; }
      s.pending = null;
      s.removed = [...s.removed.filter((r) => !keep.some((k) => same(r, k))), ...keep];
    },
    addGenerated: (r) => s.edit(addToVaultOps(r), [], r),
    async pick(p) {
      if (!s.now || !io) throw new Error(NO_VAULT);
      await applyVaultEdit(io, s.now.vault.id, s.pending?.ops ?? [], p);
      s.reset();
    },
    takenOut: (ops) => (s.now?.runes ?? []).filter((r) => ops.some((o) =>
      o.op === "removeRune" ? !r.set && r.library === o.ref.library && r.id === o.ref.id
        : o.op === "removeRuneset" ? !!r.set && r.set.library === o.ref.library && r.set.set === o.ref.set
          : o.op === "member" && !o.ref.on && !!r.set && r.set.library === o.ref.library && r.set.set === o.ref.runeset
            && r.library === o.ref.rune.library && r.id === o.ref.rune.id)),
  };
  return s;
}
