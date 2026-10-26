// One rune set card: the head every rune list shares (library sets, Inherited Runes,
// Local Files and the classic view's sets) and the details shell around it. Styles: runes.css `.runes-card`.
import { iconImg, type ColorIcon } from "../icon-img";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The set head: icon slot, name, condition slot, count. A null count leaves `.runes-sc` empty. */
export function setHead(name: string, count: number | string | null, icon: ColorIcon | null, cond?: HTMLElement): HTMLElement {
  const sum = node("summary", "runes-set-head");
  const scp = node("span", "runes-scp");
  if (icon) scp.appendChild(iconImg(icon));
  sum.append(scp, node("span", "runes-sn", name), cond ?? node("span", "runes-cond"), node("span", "runes-sc", count === null ? "" : String(count)));
  return sum;
}

/** The set card: `details.runes-set.runes-card.<hue>` holding `head`. */
export function setCard(hue: string, head: HTMLElement): HTMLDetailsElement {
  const det = node("details", `runes-set runes-card ${hue}`);
  det.appendChild(head);
  return det;
}
