// src\runes\bare\library-delete.ts — Delete Rune and Delete Library in Modify.
// A library rune or a whole import library leaves the store through `bare_library_delete` (it moves into the
// library backup; unlocked vaults drop it, locked sessions keep their copy). Each action asks first on an inline
// notice card (the choice card's look, vault-edit.ts); nothing here writes a file or a launcher row.
export const DELETE_RUNE_LABEL = "Delete Rune";
export const DELETE_LIBRARY_LABEL = "Delete Library";
export const STOCK_LIBRARY = "stock";

/** What the user asked to delete: a library, or one rune of it. */
export interface DeleteTarget { library: string; id?: string }

export const sameTarget = (a: DeleteTarget | null, b: DeleteTarget): boolean => !!a && a.library === b.library && a.id === b.id;

/** The confirm text. */
export function confirmText(name: string): string {
  return `Delete ${name}? It moves to the library backup. Unlocked vaults that hold it drop it; locked sessions keep their copy.`;
}

/** Only an import library can be deleted; the stock library never offers it. */
export const deletable = (library: string): boolean => library !== STOCK_LIBRARY;

/** `list` less what `t` deleted: one rune, or every rune of the library. */
export function without<T extends { library: string; id: string }>(list: readonly T[], t: DeleteTarget): T[] {
  return list.filter((r) => r.library !== t.library || (t.id !== undefined && r.id !== t.id));
}

/** The confirm card: Delete and Cancel. */
export function deleteConfirm(name: string, onDelete: () => void, onCancel: () => void): HTMLElement {
  const root = document.createElement("div");
  root.className = "blk blk-notice-card runes-vault-choice runes-delete-confirm";
  const body = document.createElement("div");
  body.className = "notice-body";
  const note = document.createElement("div");
  note.className = "blk-notice warn";
  note.textContent = confirmText(name);
  body.append(note);
  const acts = document.createElement("div");
  acts.className = "wb-actions notice-acts";  const button = (label: string, primary: boolean, run: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    // the shared decision pair (decision-pair.css): red Delete (.swap-yes), grey Cancel (.swap-no)
    b.className = primary ? "swap-yes" : "swap-no";
    b.textContent = label;
    b.addEventListener("click", run);
    return b;
  };
  acts.append(button("Delete", true, onDelete), button("Cancel", false, onCancel));
  root.append(body, acts);
  return root;
}

/** A text button in the Modify action row; `run` asks, it does not delete. */
export function deleteButton(label: string, title: string, run: () => void, disabled: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ws-btn";
  b.textContent = label;
  b.title = title;
  b.disabled = disabled;
  b.addEventListener("click", run);
  return b;
}
