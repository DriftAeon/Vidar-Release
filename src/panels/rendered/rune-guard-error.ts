// The Bare guard's tagged JSON survives both direct Tauri rejection and Falcon's "spawn: " prefix.
// Its card (C1, run 2026-10-25-rune-vault L3b2) removes the rune from the tab's Rune Vault through `rune_vault_edit`
// with the vault's lock rules: an open vault is edited, a locked one waits for Make Variant or Edit Original. A rune
// riding in a placed runeset goes out of the vault's copy of it through the `member` op (L3d).
import { invoke, type BareRuneGuardRefusal, type VaultOp } from "../../ipc";
import { nameLabel } from "../../runes/bare/row-name";
import { editVault, EDIT_ORIGINAL_LABEL, EDIT_ORIGINAL_RESTART, MAKE_VARIANT_LABEL, type VaultEditIo, type VaultPick } from "../../runes/bare/vault-edit";
import { tabVaultEditIo } from "../../runes/bare/vault-edit-io";
import { LOCKED_EDIT_TEXT, memberOp } from "../../runes/bare/view-vault";
import { sessionLaunchInfo } from "../sessions/lookup";
import { actionButton, card } from "./notice-actions";

export const RUNE_GUARD_REFUSAL_MARKER = "VIDAR_RUNE_GUARD_REFUSAL:";
export const REMOVE_RUNE_LABEL = "Remove Rune";
const REMOVE_FAILED = "Couldn't remove this rune; try again";
const IN_RUNESET = "Couldn't remove this rune: it comes with a runeset this vault does not hold; switch the runeset off in Modify";
const NO_VAULT = "Couldn't remove this rune: this tab has no vault";

export function runeGuardRefusal(error: unknown): BareRuneGuardRefusal | null {
  const raw = String(error);
  const at = raw.indexOf(RUNE_GUARD_REFUSAL_MARKER);
  if (at < 0) return null;
  try {
    const value: unknown = JSON.parse(raw.slice(at + RUNE_GUARD_REFUSAL_MARKER.length));
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if (typeof v.reason !== "string" || typeof v.id !== "string" || !v.id
      || (v.library !== null && typeof v.library !== "string") || typeof v.set !== "string" || !v.set) return null;
    return { reason: v.reason, id: v.id, library: v.library, set: v.set } as BareRuneGuardRefusal;
  } catch { return null; }
}

/** The vault tab `tab` spawns on: its session record's, else its launch vault. */
async function tabVault(tab: string): Promise<string | null> {
  const rec = await invoke("rune_vault_session", { tab }).catch(() => null);
  return rec?.vault.id ?? sessionLaunchInfo(tab)?.vault ?? null;
}

/** The `removeRune` op for the refused rune when it is a one-off in vault `id`; when it rides in a placed runeset
 *  (the refusal names that runeset), the `member` op that takes it out of the vault's copy of it (L3d). Throws when
 *  neither holds it. */
async function removeOps(io: VaultEditIo, id: string, r: BareRuneGuardRefusal): Promise<VaultOp[]> {
  const v = await io.current(id);
  const one = v.runes.find((x) => x.id === r.id && (r.library === null || x.library === r.library));
  if (one) return [{ op: "removeRune", ref: one }];
  const set = v.runesets.map((c) => c.source).find((s) => s.set === r.set && (r.library === null || s.library === r.library));
  if (!set) throw new Error(IN_RUNESET);
  // the refusal names the runeset's library; a cross-library slot's own library comes from the vault view
  const viewed = (await io.currentView(id).catch(() => null))?.runes
    .find((x) => x.id === r.id && x.set?.library === set.library && x.set.set === set.set);
  return [memberOp(set, { library: viewed?.library ?? set.library, id: r.id }, false)];
}

/** One guarded rune in a failed Bare spawn: Remove Rune takes it out of the tab's vault, then retries the spawn.
 *  A locked vault turns the card into the Make Variant / Edit Original choice; Make Variant moves the tab to the
 *  new vault and Edit Original edits the locked one; both retry fresh (`retry(true)`: a resume would load the
 *  thread's old vault state), as Modify's choice card respawns. */
export function runeGuardCard(tab: string, refusal: BareRuneGuardRefusal, retry: (fresh: boolean) => Promise<void>, io: VaultEditIo = tabVaultEditIo(tab)): HTMLElement {
  const why = refusal.reason.includes("holds the account name") ? "Holds Your Account Name"
    : refusal.reason.includes("holds the user-profile path") ? "Holds Your Profile Path"
    : refusal.reason.includes("unsubstituted placeholder") ? "Has an Unsubstituted Placeholder"
    : "Failed the Spawn Guard";
  const title = `Rune ${nameLabel(refusal.id)} ${why}`;
  const c = card(title);
  let target: { id: string; ops: VaultOp[] } | null = null;
  const run = async (pick?: VaultPick): Promise<void> => {
    if (!target) {
      const id = await tabVault(tab);
      if (!id) throw new Error(NO_VAULT);
      target = { id, ops: await removeOps(io, id, refusal) };
    }
    const r = await editVault(io, target.id, target.ops, pick);
    if (r.kind === "failed") throw new Error(r.error.startsWith("Couldn't ") ? r.error : `${REMOVE_FAILED}: ${r.error}`);
    if (r.kind === "ask") {
      c.text.textContent = `${title}. ${LOCKED_EDIT_TEXT} ${EDIT_ORIGINAL_RESTART}`;
      c.acts.replaceChildren(
        actionButton(MAKE_VARIANT_LABEL, "Making Variant", true, () => run("variant"), c.error, REMOVE_FAILED),
        actionButton(EDIT_ORIGINAL_LABEL, "Editing", false, () => run("invalidate"), c.error, REMOVE_FAILED),
      );
      return;
    }
    if (r.mode === "variant" && !(await io.moveTab(r.vault.id))) throw new Error("Couldn't move this tab to the new vault");
    c.root.remove();
    await retry(r.mode === "variant" || r.mode === "invalidate");
  };
  c.acts.appendChild(actionButton(REMOVE_RUNE_LABEL, "Removing", true, () => run(), c.error, REMOVE_FAILED));
  return c.root;
}
