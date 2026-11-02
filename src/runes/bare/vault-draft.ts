// src\runes\bare\vault-draft.ts — New Rune Vault's draft: the Runes view's Modify (view.ts) mounted on a vault that
// does not exist yet. The draft starts from the Vidar Runeset alone (`rune_vault_read{id:null, agent}`, the blank vault
// Rust renders without storing it) and stages changes over it; nothing is written until Done, whose name prompt
// (vault-save-as.ts) hands the name and the staged ops to `create` (vault-create.ts `createFromDraft`, `from: null`).
// Cancel drops the draft. No second Modify: only the IO and Done's ending differ.
import type { VaultOp } from "../../ipc";
import type { VaultEditIo } from "./vault-edit";
import { vaultIpc, type VaultIo } from "./vault-io";

/** What a draft's Done and Cancel run (the vault pick binds them). */
export interface VaultDraft {
  /** The name set from the pane head's rename pencil ("" or absent = unnamed). Set, Done skips the name prompt. */
  name?: string;
  /** Done's name prompt confirmed: make the vault from the blank vault (`base` null) plus the staged `ops`.
   *  Throws the store's refusal (a taken name), which the prompt shows; the draft stays. */
  create(name: string, base: { id: string; hash: string } | null, ops: VaultOp[]): Promise<void>;
  /** Cancel: drop the draft; nothing was written. */
  cancel(): void;
}

const NO_WRITE = "A draft vault is written only by Done.";

/** The view's vault IO for a draft of `agent`: the session reads as the blank vault, every read is a plain
 *  `rune_vault_read` of it (whatever id asks), and the write calls refuse (Lock is hidden in Modify, and Done never edits a draft). */
export function draftIo(agent: string): { vault: Pick<VaultIo, "session" | "read" | "lock">; vaultEdit: VaultEditIo } {
  const read: VaultIo["read"] = () => vaultIpc.read(null, undefined, agent);
  return {
    vault: {
      session: async () => {
        const v = (await read(null)).vault;
        return { vault: { id: v.id, hash: v.hash } } as Awaited<ReturnType<VaultIo["session"]>>;
      },
      read,
      lock: () => Promise.reject(new Error(NO_WRITE)),
    },
    vaultEdit: {
      read,
      edit: () => Promise.reject(new Error(NO_WRITE)),
    },
  };
}
