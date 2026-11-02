// src\runes\bare\field-focus.ts — a field's focus and caret across a repaint (the pattern of settings/live-list.ts); Save Vault As's name keeps its caret through it.

/** A field's focus and caret, read before a repaint replaces it. */
export interface FieldFocus { key: string; start: number | null; end: number | null }

/** The focused `[data-keep]` field under `root`, or null. */
export function captureField(root: HTMLElement): FieldFocus | null {
  const a = document.activeElement as (HTMLInputElement | HTMLTextAreaElement) | null;
  const key = a && root.contains(a) ? a.dataset?.keep : undefined;
  if (!a || !key) return null;
  return { key, start: typeof a.selectionStart === "number" ? a.selectionStart : null, end: typeof a.selectionEnd === "number" ? a.selectionEnd : null };
}

/** Focuses the redrawn field `f.key` and puts its caret back; an absent field is left alone. */
export function restoreField(root: HTMLElement, f: FieldFocus | null): void {
  if (!f) return;
  const now = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-keep="${f.key}"]`);
  if (!now) return;
  now.focus();
  if (f.start !== null && f.end !== null) now.setSelectionRange(f.start, f.end);
}
