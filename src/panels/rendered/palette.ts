// Slash palette of a Rendered body: the command list under the composer, filtered
// while the text is a bare "/word", with keyboard selection and pick.

import { btn } from "./dom";
import type { RenderedState } from "./state";

/** What the palette closes over in createRenderedBody. */
export interface PaletteDeps {
  palette: HTMLElement;
  textarea: HTMLTextAreaElement;
}

export function createPalette(S: RenderedState, deps: PaletteDeps) {
  const { palette, textarea } = deps;
  // slash palette: filters the session's commands while the text is a bare "/word"
  function updatePalette() {
    const v = textarea.value;
    const m = /^\/([^\s/]*)$/.exec(v);
    if (!m || !S.commands.length) { hidePalette(); return; }
    const q = m[1].toLowerCase();
    const hits = S.commands.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 12);
    if (!hits.length) { hidePalette(); return; }
    palette.textContent = "";
    for (const c of hits) {
      const row = btn(`/${c}`, "palette-row", () => { S.paletteSel = c; pickPalette(); });
      palette.appendChild(row);
    }
    S.paletteSel = hits[0];
    palette.classList.remove("hidden");
    markPalette();
  }
  function markPalette() {
    for (const r of palette.children) r.classList.toggle("on", (r as HTMLElement).textContent === `/${S.paletteSel}`);
  }
  function movePalette(d: number) {
    const rows = [...palette.children].map((r) => (r as HTMLElement).textContent!.slice(1));
    const i = Math.max(0, rows.indexOf(S.paletteSel ?? ""));
    S.paletteSel = rows[(i + d + rows.length) % rows.length];
    markPalette();
  }
  function pickPalette() {
    if (S.paletteSel) textarea.value = `/${S.paletteSel} `;
    hidePalette();
    textarea.focus();
  }
  function hidePalette() {
    palette.classList.add("hidden");
    S.paletteSel = null;
  }

  return { updatePalette, movePalette, pickPalette, hidePalette };
}
