// Structural DOM morph: update a live tree in place to match a freshly built
// one, instead of replacing it wholesale. Written for the Rendered panel's
// streaming text (src\panels\rendered.ts `paintText`), which used to rebuild
// every node of a reply up to 60x/second — the teardown, not the markdown
// parse, was the cost (parse measured at 0.51 ms for a 20 KiB reply).
//
// Safe here because the markdown builder (src\panels\document.ts `buildTokens`)
// emits inert DOM: elements, text nodes, classes and attributes, with no event
// listeners and no element state. Anything with listeners or state would need
// keys; this deliberately has none. Matching is positional, so a structural
// flip (a paragraph becoming a table when its delimiter row lands, a tight list
// going loose) rebuilds that subtree once — the same cost as the old path, and
// only for the block that flipped.
//
// Nothing here sets innerHTML: the only writes are nodeValue, setAttribute,
// removeAttribute and node insertion/removal of builder output.

/** Update `host`'s single rendered root toward `next`, in place where possible. */
export function morphInto(host: HTMLElement, next: HTMLElement): void {
  const live = host.firstChild;
  // Wholesale replace when there is no comparable root: first paint, or the
  // root itself changed shape (rendered <-> fallback <pre>, or a partial tree
  // from the builder's depth cap). Deriving this from the DOM rather than a
  // remembered flag keeps the caller stateless.
  if (
    !live ||
    live !== host.lastChild ||
    live.nodeType !== Node.ELEMENT_NODE ||
    (live as Element).tagName !== next.tagName ||
    (live as Element).className !== next.className
  ) {
    host.replaceChildren(next);
    return;
  }
  syncAttrs(live as Element, next);
  morphChildren(live as Element, next);
}

/** `next`'s attributes onto `live`, removing any `next` does not carry.
 *  Generic over the attribute list on purpose: a whitelist would miss the
 *  inline `text-align` the builder puts on table cells. */
function syncAttrs(live: Element, next: Element): void {
  for (let i = live.attributes.length - 1; i >= 0; i--) {
    const name = live.attributes[i].name;
    if (!next.hasAttribute(name)) live.removeAttribute(name);
  }
  for (let i = 0; i < next.attributes.length; i++) {
    const a = next.attributes[i];
    if (live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value);
  }
}

function morphChildren(live: Element, next: Element): void {
  let l = live.firstChild;
  let n = next.firstChild;
  while (n) {
    // insertion moves `n` out of `next`, so its sibling is read first
    const nAfter = n.nextSibling;
    if (!l) {
      live.appendChild(n);
      n = nAfter;
      continue;
    }
    const lAfter = l.nextSibling;
    if (l.nodeType === Node.TEXT_NODE && n.nodeType === Node.TEXT_NODE) {
      if (l.nodeValue !== n.nodeValue) l.nodeValue = n.nodeValue;
    } else if (
      l.nodeType === Node.ELEMENT_NODE &&
      n.nodeType === Node.ELEMENT_NODE &&
      (l as Element).tagName === (n as Element).tagName
    ) {
      syncAttrs(l as Element, n as Element);
      morphChildren(l as Element, n as Element);
    } else {
      live.replaceChild(n, l);
    }
    l = lAfter;
    n = nAfter;
  }
  while (l) {
    const lAfter = l.nextSibling;
    live.removeChild(l);
    l = lAfter;
  }
}
