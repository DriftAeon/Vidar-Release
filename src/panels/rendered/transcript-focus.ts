// A click on the transcript's empty ground hands focus back to the composer, as a click in the
// composer does (the pane's focusin marks the tab focused either way). Controls keep their own
// click; a drag that selected text is left alone so copying still works.
//
// The press itself still moves focus off the composer: the transcript is focusable (tabIndex -1)
// and a mousedown's default action focuses it, and that default cannot be prevented without also
// killing drag-select and double-click word select. So while a press that started with the
// composer focused is down, the composer carries `focus-held`, which draws the same focused look;
// without it the accent border dropped on mousedown and came back on click, a visible flash.

const OWN_CLICK = "button, a, summary, details, input, textarea, select, pre";

export function wireTranscriptFocus(transcript: HTMLElement, textarea: HTMLTextAreaElement): () => void {
  const release = () => textarea.classList.remove("focus-held");
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (textarea.ownerDocument.activeElement !== textarea) return;
    if ((e.target as Element).closest(OWN_CLICK)) return;
    textarea.classList.add("focus-held");
    // mouseup and its click dispatch together; the next task sees whether the click refocused
    // (a press that became a selection, or ended outside, leaves the composer unfocused)
    window.addEventListener("mouseup", () => setTimeout(release, 0), { once: true, capture: true });
  };
  const onClick = (e: MouseEvent) => {
    if ((e.target as Element).closest(OWN_CLICK)) return;
    if (!window.getSelection()?.isCollapsed) return;
    textarea.focus();
  };
  transcript.addEventListener("mousedown", onDown);
  transcript.addEventListener("click", onClick);
  textarea.addEventListener("focus", release);
  return () => {
    transcript.removeEventListener("mousedown", onDown);
    transcript.removeEventListener("click", onClick);
    textarea.removeEventListener("focus", release);
    release();
  };
}
