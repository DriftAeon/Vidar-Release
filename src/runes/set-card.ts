// One rune set card: the head every rune list shares (library sets, Inherited Runes,
// Local Files and the classic view's sets) and the details shell around it. Styles: runes.css `.runes-card`.
import { iconImg, type ColorIcon } from "../icon-img";
import { node } from "../browser/list";

/** A second or third quick click on a summary (event.detail > 1) would word- or line-select its text; stopping that
 *  default leaves a plain drag selection of names and opened bodies working (no user-select: none). */
export function noQuickSelect(sum: HTMLElement): void {
  sum.addEventListener("mousedown", (e) => { if (e.detail > 1) e.preventDefault(); });
}

/** The set head: icon slot, name, condition slot, count. A null count leaves `.runes-sc` empty. `check` (Modify's
 *  checkbox or its empty slot, check-box.ts) goes first and makes the head `has-check`, whose columns line the
 *  checkbox and title up with the rune rows below (runes.css). */
export function setHead(name: string, count: number | string | null, icon: ColorIcon | null, cond?: HTMLElement, check?: HTMLElement): HTMLElement {
  const sum = node("summary", check ? "runes-set-head has-check" : "runes-set-head");
  const scp = node("span", "runes-scp");
  noQuickSelect(sum);
  if (icon) scp.appendChild(iconImg(icon));
  if (check) sum.appendChild(check);
  sum.append(scp, node("span", "runes-sn", name), cond ?? node("span", "runes-cond"), node("span", "runes-sc", count === null ? "" : String(count)));
  return sum;
}

/** The set card: `details.runes-set.runes-card.<hue>` holding `head`. */
export function setCard(hue: string, head: HTMLElement): HTMLDetailsElement {
  const det = node("details", `runes-set runes-card ${hue}`);
  det.appendChild(head);
  return det;
}
