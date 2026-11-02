// src\runes\bare\vault-modify-state.ts — what the Bare view's Modify holds for a tab's Rune Vault: the vault as it is
// now, the staged changes (vault-pending.ts) Done sends as one edit, the Rune Library's runes, and a locked-vault edit
// waiting on Make Variant / Edit Original. Every write goes through vault-edit.ts; nothing touches a launcher row.
import type { LibraryRuneset, VaultOp } from "../../ipc";
import { newSaveAsState, saveVaultAs, type SaveAsState, type VaultCreateCall } from "./vault-save-as";
import type { VaultView, VaultViewRune } from "./cake";
import { editVault, settleEdit, variantSavedNotice, type VaultEditIo, type VaultPick } from "./vault-edit";
import { LOCKED_EDIT_TEXT, type PendingEdit } from "./view-vault";
import { prune, type Pending } from "./vault-pending";
import { errText } from "../../err-text";

const NO_VAULT = "This tab has no vault to edit.";

/** What Done's one edit came to: parked on the choice card, or landed (a respawn that threw after it is `error`). */
export type CommitOutcome = { kind: "ask" } | { kind: "landed"; error?: string };

export interface VaultModifyState {
  /** The vault as it is now (read without a hash), which Modify draws and edits; null without a record. */
  now: VaultView | null;
  /** Runes a write took out, kept so their switches can put them back (none while changes are staged). */
  removed: VaultViewRune[];
  /** Modify's staged changes; Done sends them, Cancel and leaving Modify drop them. */
  changes: Pending;
  pending: PendingEdit | null;
  /** The notice a Make Variant left (`Saved as <name>. New sessions can pick it.`); the view shows it once Modify
   *  has closed. Opening Modify again clears it. */
  notice: string | null;
  /** The Rune Library's runes: what this tab's agent can load from its libraries; null until read. */
  library: VaultViewRune[] | null;
  /** Warnings the library read carried (`rune_vault_library_runes` `.warnings`). */
  libraryWarnings: string[];
  /** The library runesets the Rune Library groups by (`rune_vault_library_runes` `.runesets`); empty until read. */
  librarySets: LibraryRuneset[];
  /** Reads the Rune Library with what `load` returns. Throws. */
  loadLibrary(load: () => Promise<VaultViewRune[] | { runes: VaultViewRune[]; warnings: string[]; runesets?: LibraryRuneset[] }>): Promise<void>;
  /** Leaving Modify drops the staged changes, the pending edit, the library and Save Vault As. */
  reset(): void;
  /** Reads vault `id` as it is now; null clears it. Staged changes re-baseline on the read (vault-pending.ts prune). */
  read(id: string | null): Promise<void>;
  /** Done: `ops` as one edit through the vault edit path. A locked vault (or one locked meanwhile) parks them as
   *  `pending`; landed, the staged changes clear. Throws the store's refusal, the changes kept. */
  commit(ops: VaultOp[]): Promise<CommitOutcome>;
  /** The user's pick for the pending edit. Landed, the staged changes clear and it resolves (to a respawn's error, if
   *  one threw after the edit); a still-locked answer resolves null with the edit kept. Throws the store's refusal onto
   *  the choice card's error line. */
  pick(p: VaultPick): Promise<string | null>;
  /** Save Vault As's name (vault-save-as.ts); drops on leaving Modify. */
  saveAs: SaveAsState;
  /** Saves the vault as it is now under `saveAs.name`; the tab keeps its copy. */
  saveVaultAs(create: VaultCreateCall): Promise<void>;
  /** The runes `ops` take out of the vault, so the view can still draw them switched off. */
  takenOut(ops: VaultOp[]): VaultViewRune[];
}

const message = errText;

/** `agent` scopes every vault read: the view holds no rune that agent can't load. */
export function vaultModifyState(io: VaultEditIo | undefined, agent?: string): VaultModifyState {
  const s: VaultModifyState = {
    now: null, removed: [], changes: new Map(), pending: null, notice: null, library: null, libraryWarnings: [], librarySets: [],
    saveAs: newSaveAsState(),
    reset() {
      s.pending = null; s.removed = []; s.library = null; s.libraryWarnings = []; s.librarySets = [];
      s.changes.clear();
      s.saveAs = newSaveAsState();
    },
    async saveVaultAs(create) {
      if (!s.now) throw new Error(NO_VAULT);
      await saveVaultAs(s.saveAs, create, s.now.vault);
    },
    async loadLibrary(load) {
      const r = await load();
      s.library = Array.isArray(r) ? r : r.runes;
      s.libraryWarnings = Array.isArray(r) ? [] : r.warnings;
      s.librarySets = Array.isArray(r) ? [] : r.runesets ?? [];
    },
    async read(id) {
      s.now = id && io ? await io.read(id, undefined, agent) : null;
      if (s.now) prune(s.changes, s.now);
    },
    async commit(ops) {
      if (!s.now || !io) throw new Error(NO_VAULT);
      const r = await editVault(io, s.now.vault.id, ops);
      if (r.kind === "ask") { s.pending = { ops, text: LOCKED_EDIT_TEXT }; return { kind: "ask" }; }
      if (r.kind === "failed") throw new Error(r.error);
      s.pending = null;
      s.changes.clear();
      // the edit landed: a respawn that throws after it is shown, but the changes are in the vault
      try { await settleEdit(io, r); } catch (e) { return { kind: "landed", error: message(e) }; }
      return { kind: "landed" };
    },
    async pick(p) {
      if (!s.now || !io) throw new Error(NO_VAULT);
      const r = await editVault(io, s.now.vault.id, s.pending?.ops ?? [], p);
      if (r.kind === "failed") throw new Error(r.error);
      if (r.kind === "ask") return null;
      s.reset();
      s.notice = r.mode === "variant" ? variantSavedNotice(r.vault.name) : null;
      // landed: a respawn that throws after it is handed back for the error line, not thrown
      try { await settleEdit(io, r); } catch (e) { return message(e); }
      return null;
    },
    takenOut: (ops) => (s.now?.runes ?? []).filter((r) => ops.some((o) =>
      o.op === "removeRune" ? !r.set && r.library === o.ref.library && r.id === o.ref.id
        : o.op === "removeRuneset" ? !!r.set && r.set.library === o.ref.library && r.set.set === o.ref.set
          : o.op === "member" && !o.ref.on && !!r.set && r.set.library === o.ref.library && r.set.set === o.ref.runeset
            && r.library === o.ref.rune.library && r.id === o.ref.rune.id)),
  };
  return s;
}
