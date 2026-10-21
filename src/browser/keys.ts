// Keyboard for one browser, attached to its own root (so only the visible browser of two handles a key).
// Skips inputs and textareas entirely, and skips buttons other than rows for every key but Escape, so
// Enter and Space keep their native meaning on a button (S5) while Esc still backs out of a view.
// Rows: Up/Down (bands are not rows), Home/End, Enter or Space activates. Escape goes to `escape()`,
// which closes in order menu, fullscreen, card, then calls the adapter's back.

export interface KeyHooks {
  /** The rows the arrows move through, in visual order. */
  rows(): HTMLElement[];
  activate(row: HTMLElement): void;
  /** True when something consumed the Escape. */
  escape(): boolean;
}

export const ROW_CLASS = "br-row";

const isRow = (t: Element) => t.classList.contains(ROW_CLASS);

/** Text entry: never handled. */
export function isField(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement
    || (t as HTMLElement).isContentEditable === true;
}

/** A button (or link-role span) that is not a row: handled for Escape only. */
export function isOtherControl(t: EventTarget | null): boolean {
  if (!(t instanceof Element) || isRow(t)) return false;
  return t.closest("button") !== null || t.getAttribute("role") === "link";
}

export function focusRow(rows: HTMLElement[], row: HTMLElement | undefined): void {
  if (!row) return;
  for (const r of rows) r.tabIndex = r === row ? 0 : -1;
  row.focus();
}

export function attachKeys(root: HTMLElement, h: KeyHooks): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target;
    if (isField(t)) return;
    if (e.key === "Escape") {
      if (h.escape()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (isOtherControl(t)) return;
    const rows = h.rows();
    const row = t instanceof Element ? (t.closest(`.${ROW_CLASS}`) as HTMLElement | null) : null;
    const at = row ? rows.indexOf(row) : -1;
    let next: HTMLElement | undefined;
    switch (e.key) {
      case "ArrowDown": next = rows[at < 0 ? 0 : Math.min(at + 1, rows.length - 1)]; break;
      case "ArrowUp": next = rows[at < 0 ? 0 : Math.max(at - 1, 0)]; break;
      case "Home": next = rows[0]; break;
      case "End": next = rows.at(-1); break;
      case "Enter":
      case " ":
        if (!row || at < 0) return;
        e.preventDefault();
        h.activate(row);
        return;
      default: return;
    }
    if (!next) return;
    e.preventDefault();
    focusRow(rows, next);
  };
  root.addEventListener("keydown", onKey);
  return () => root.removeEventListener("keydown", onKey);
}
