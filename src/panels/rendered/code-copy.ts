// Copy button on fenced code blocks of agent text (Claude and Codex Rendered tabs).
// One button per <pre>, created once and remembered per block. The markdown morph strips
// children the built tree does not carry, so paintText lifts the buttons out before a
// repaint and `addCopyButtons` puts the same nodes back after it; a <pre> the morph
// replaced gets a fresh button.

import { copyText } from "../../clipboard";
import { lucide } from "../../icons";

const buttons = new WeakMap<Element, HTMLButtonElement>();

/** the block's raw source: the <code> text, read at click time so a streaming block copies what has arrived */
function blockSource(pre: Element): string {
  return (pre.querySelector("code") ?? pre).textContent ?? "";
}

function makeButton(pre: HTMLElement): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-btn code-copy";
  b.title = "Copy";
  b.setAttribute("aria-label", "Copy");
  b.appendChild(lucide("copy"));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    void copyText(blockSource(pre));
  });
  return b;
}

/** Take the buttons off their blocks ahead of a morph. */
export function liftCopyButtons(host: HTMLElement): void {
  for (const b of host.querySelectorAll("pre > button.code-copy")) b.remove();
}

/** Give every fenced <pre> in `host` its one button (the remembered node where the block survived the morph). */
export function addCopyButtons(host: HTMLElement): void {
  for (const pre of host.querySelectorAll<HTMLElement>("pre")) {
    if (pre.classList.contains("blk-text-fallback")) continue;
    let b = buttons.get(pre);
    if (!b) { b = makeButton(pre); buttons.set(pre, b); }
    if (b.parentNode !== pre) pre.appendChild(b);
  }
}
