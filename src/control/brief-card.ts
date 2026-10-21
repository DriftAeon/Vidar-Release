// src\control\brief-card.ts — the spawn card's Brief row. Pure formatting, no imports (tests load it directly).

/** `<n> Lines · <b> Bytes` of the whole prompt. */
function sizeText(text: string): string {
  return `${text.split(/\r?\n/).length} Lines · ${new TextEncoder().encode(text).length} Bytes`;
}

/** The Brief row value: the path the client read (display only, Rust-checked) and the size. */
function briefText(brief: string, text: string): string {
  return `${brief} · ${sizeText(text)}`;
}

/** The Brief row list: one row for a `--brief` request (`brief` is its path), none for `--text` (null). */
export function briefRows(brief: unknown, text: string): [string, string][] {
  return typeof brief === "string" ? [["Brief", briefText(brief, text)]] : [];
}
