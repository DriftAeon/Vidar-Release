// Source view and diff colouring for the Document view.

export function sourcePre(text: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "doc-source";
  pre.textContent = text;
  return pre;
}

/** Colour the lines of ```diff blocks in place: spans inside the <code>, so the
 *  block element (and every comment anchor on it) is untouched. Idempotent. */
export function colourDiffs(host: HTMLElement) {
  for (const code of host.querySelectorAll<HTMLElement>('code[data-lang="diff"]')) {
    if (code.dataset.coloured) continue;
    const lines = code.textContent?.split("\n") ?? [];
    code.textContent = "";
    lines.forEach((l, i) => {
      const s = document.createElement("span");
      s.className = l.startsWith("+++") || l.startsWith("---") ? "diff-meta"
        : l.startsWith("+") ? "diff-add"
        : l.startsWith("-") ? "diff-del"
        : l.startsWith("@@") ? "diff-hunk"
        : /^(diff --git|index |rename |similarity |new file|deleted file|old mode|new mode|Subproject)/.test(l) ? "diff-meta"
        : "";
      s.textContent = l;
      code.appendChild(s);
      if (i < lines.length - 1) code.appendChild(document.createTextNode("\n"));
    });
    code.dataset.coloured = "1";
  }
}
