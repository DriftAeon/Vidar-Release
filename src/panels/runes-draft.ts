// New Rune Vault in the Runes panel: a waiting tab's draft editor is the Bare view's own Modify mounted on a draft of
// the blank vault, the Vidar Runeset alone (src/runes/bare/vault-draft.ts). The vault picker owns it (shows its root, disposes it on
// Done or Cancel); runes.ts places its Done and Cancel in the pane head and its Rune Library on the left cover.
import { mountBareView, type BareViewCtx, type BareViewHandle } from "../runes/bare/view";
import { createBareIo } from "../runes/bare/io";
import { draftIo, type VaultDraft } from "../runes/bare/vault-draft";
import type { DraftEditor } from "../runes/bare/vault-pick-view";

/** The fields of a Bare entry the left cover reads (runes.ts syncCover). */
export interface CoverEntry { handle: BareViewHandle; modifying: boolean; coverGone: boolean; cover?: HTMLElement; draft?: VaultDraft }

export interface DraftHost {
  /** The view fields a tab's own Bare view gets (agent, folder, card, Generate models). */
  view: Pick<BareViewCtx, "agent" | "cwd" | "profile" | "card" | "gen" | "modelsReady">;
  /** The draft opened (an entry) or closed (null): place or clear its head buttons and cover. */
  shown(e: CoverEntry | null): void;
  /** Modify opened or closed: re-place the left cover. */
  changed(): void;
}

const drafts = new Map<string, CoverEntry>();

/** Tab `tab`'s open draft, so a return to the tab shows it again. */
export const tabDraft = (tab: string): CoverEntry | undefined => drafts.get(tab);

export function openDraft(tab: string, hooks: VaultDraft, host: DraftHost): DraftEditor {
  const io = draftIo(host.view.agent);
  let e: CoverEntry | undefined;
  const handle = mountBareView(document.createElement("div"), {
    ...host.view, vault: io.vault, vaultEdit: io.vaultEdit, placesLibrary: true, retry: false, draft: hooks,
    onModifyChange: (on) => {
      if (!e) return;
      e.modifying = on;
      if (on) e.coverGone = false;
      host.changed();
    },
  }, createBareIo(), null);
  const entry: CoverEntry = { handle, modifying: false, coverGone: false, draft: hooks };
  e = entry;
  drafts.set(tab, entry);
  host.shown(entry);
  return {
    root: handle.root,
    dispose() {
      drafts.delete(tab);
      handle.dispose();
      host.shown(null);
    },
  };
}
