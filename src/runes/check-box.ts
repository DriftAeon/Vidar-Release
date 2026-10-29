// src\runes\check-box.ts — the Modify checkbox: a 16px square left of a rune bar or in a set head's first column. One builder for
// the vault's rune rows, runeset and library heads, and the Modules group heads. Styles: runes.css `.runes-check`.

export type CheckState = "on" | "off" | "mixed";

const SVG = "http://www.w3.org/2000/svg";
// the mock's tick (g-tick) and a centred dash for a partly-on head, both on a 12-unit box
const TICK = "M2.5 6.3 L5 8.7 L9.6 3.6";
const DASH = "M3 6 H9";

function glyph(state: CheckState): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "runes-check-mark");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", state === "mixed" ? DASH : TICK);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

/** A checkbox button: `role=checkbox`, `aria-checked` true / false / mixed. A click flips without opening the
 *  `details` it may sit in (a set head is a `summary`). */
export function checkBox(o: { state: CheckState; disabled: boolean; title: string; label: string; flip: () => void }): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "runes-check";
  b.setAttribute("role", "checkbox");
  b.setAttribute("aria-checked", o.state === "on" ? "true" : o.state === "off" ? "false" : "mixed");
  b.setAttribute("aria-label", o.label);
  b.title = o.title;
  b.disabled = o.disabled;
  if (o.state !== "off") b.appendChild(glyph(o.state));
  b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); o.flip(); });
  return b;
}

/** The checkbox's empty column, for a head with nothing to switch, so its title keeps the checked heads' x. */
export function checkSlot(): HTMLElement {
  const s = document.createElement("span");
  s.className = "runes-check-slot";
  s.setAttribute("aria-hidden", "true");
  return s;
}

/** A rune card with its checkbox to the left of the bar, outside it. */
export function checkRow(check: HTMLElement, card: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "runes-row";
  row.append(check, card);
  return row;
}
