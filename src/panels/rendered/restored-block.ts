// The history-replay card: clock and "2 Turns". A truncated replay says so in a tooltip only.

import { el } from "./dom";
import { iconImg } from "../../icon-img";

export function restoredCard(text: string, truncated: boolean): HTMLElement {
  const card = el("div", "blk blk-restored");
  card.append(iconImg("restore"), el("span", undefined, text));
  if (truncated) card.title = "Older history omitted"; // copy-ok: full-sentence tooltip, sentence case
  return card;
}
