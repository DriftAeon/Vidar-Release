// Estimated token cost of the On rune bodies in one Bare set head: `<loaded>/<total> Tokens`.
import { brickOn } from "./view-sets";
import { isLoaded, tokenLabel } from "./loaded-count";
import type { ViewLib } from "./view-types";

const TIP = "Tokens loaded at launch out of all tokens in the set; recall and paths runes load on demand. Estimated from rune text, about 4 bytes per token; rune markers add about 6 tokens each and are not counted.";

export function costBar(lib: ViewLib): HTMLElement | null {
  const on = lib.bricks.filter((brick) => brickOn(lib, brick));
  if (!on.length) return null;

  const estimate = on.map((brick) => ({ brick, tokens: Math.ceil(new TextEncoder().encode(brick.body).length / 4) }));
  const total = estimate.reduce((sum, item) => sum + item.tokens, 0);
  const loaded = estimate.filter((item) => isLoaded(item.brick)).reduce((sum, item) => sum + item.tokens, 0);
  const wrap = document.createElement("span");
  wrap.className = "runes-cost";
  const label = document.createElement("span");
  label.className = "runes-cost-label";
  label.textContent = tokenLabel(loaded, total);
  label.title = TIP; // copy-ok: full-sentence tooltip, sentence case
  wrap.appendChild(label);
  return wrap;
}
