// The update card's frame: a fixed aside with a Close X that is always there and a body the
// groups paint into. Closing only hides it; whatever runs behind the card keeps running. No imports
// beyond types, so tests load it under node (the icon comes in as a factory).

export interface CardShell {
  card: HTMLElement;
  /** Where the groups go. */
  body: HTMLElement;
  show(): void;
  hide(): void;
  /** Removes the card and its Escape listener. */
  destroy(): void;
}

export function cardShell(doc: Document, closeIcon: () => Node): CardShell {
  const card = doc.createElement("aside");
  card.className = "startup-updates vs-confirm";
  card.setAttribute("role", "region");
  card.setAttribute("aria-live", "polite");
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "su-close";
  close.title = "Close";
  close.setAttribute("aria-label", "Close");
  close.appendChild(closeIcon());
  const body = doc.createElement("div");
  body.className = "su-scroll";
  card.append(close, body);
  const hide = (): void => { card.hidden = true; };
  // Escape closes when focus is in the card or nowhere (a disabled button gives focus up to the body);
  // a key another handler already took (a dialog's own Escape) is left alone.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || e.defaultPrevented || card.hidden) return;
    const at = doc.activeElement;
    if (at && at !== doc.body && !card.contains(at)) return;
    hide();
  };
  close.addEventListener("click", hide);
  doc.addEventListener("keydown", onKey);
  doc.body.appendChild(card);
  return {
    card, body, hide,
    show: () => { card.hidden = false; },
    destroy: () => { doc.removeEventListener("keydown", onKey); card.remove(); },
  };
}
