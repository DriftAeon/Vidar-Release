// src\runes\bare\library-delete.ts — Delete Rune and Delete Runeset in the Rune Library (Modify).
// A library rune, or a library runeset alone, leaves the store through `bare_library_delete` with `rune` naming it (it
// moves into the library backup; unlocked vaults drop it, locked sessions keep their copy). A deleted runeset's runes
// stay in the library. Each action asks first on an inline confirm row; nothing here writes a file or a launcher row.
import { confirmRow, el } from "../../dom";

export const DELETE_RUNE_LABEL = "Delete"; // the rune's own card says which rune
export const DELETE_RUNESET_LABEL = "Delete Runeset";
export const VIDAR_LIBRARY = "vidar";
/** The one runeset of the Vidar library every Rune Vault holds (Rust `VIDAR_SET`). */
export const VIDAR_SET = "vidar";

/** What the user asked to delete: rune `id` of `library`, or (`runeset`) its runeset `id`. */
export interface DeleteTarget { library: string; id: string; runeset?: boolean }

export const sameTarget = (a: DeleteTarget | null, b: DeleteTarget): boolean =>
  !!a && a.library === b.library && a.id === b.id && !!a.runeset === !!b.runeset;

/** The confirm text for a rune. */
export function confirmText(name: string): string {
  return `Delete ${name}? It moves to the library backup. Unlocked vaults that hold it drop it; locked sessions keep their copy.`;
}

/** The confirm text for a runeset: its runes stay. */
export function runesetConfirmText(name: string): string {
  return `Delete ${name}? The runeset moves to the library backup and its runes stay in the library. Unlocked vaults that hold it drop it; locked sessions keep their copy.`;
}

/** Only an import library's runes can be deleted. The Vidar library never offers it, nor does a library the store marks
 *  `fixed` (Rust `library_sets::fixed`: the rules library, `rulesLibrary` in vidar.json, whose id is its folder name). */
export const deletable = (library: string, runesets: readonly { library: string; fixed: boolean }[] = []): boolean =>
  library !== VIDAR_LIBRARY && !runesets.some((s) => s.library === library && s.fixed);

/** `list` less the rune `t` deleted. */
export function without<T extends { library: string; id: string }>(list: readonly T[], t: DeleteTarget): T[] {
  return list.filter((r) => r.library !== t.library || r.id !== t.id);
}

/** The confirm row where the Delete button sat (on a rune's card, or at the end of a runeset's): the warning on the
 *  left, then the shared decision pair (red Delete, grey Cancel) on the right. The button is gone until the row is answered. */
export function deleteInline(name: string, onDelete: () => void, onCancel: () => void, text = confirmText(name)): HTMLElement {
  const root = el("div", "runes-delete-confirm runes-delete-inline");
  confirmRow({
    root,
    note: el("span", "runes-delete-text", text),
    acts: el("span", "runes-delete-acts"),
    yes: { label: "Delete", run: onDelete },
    no: { label: "Cancel", run: onCancel },
  });
  return root;
}

/** A text button; `run` asks, it does not delete. */
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
