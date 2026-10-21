// The Cards page: a read-only list of every Rendered-tab card kind (chain segment and pill) with its
// icon, colour and the tools it covers. The data is panels/rendered/card-kinds.ts; the colour is the
// live rendered-chain.css rule, reached by drawing each sample as a real `.chain-seg` carrying
// data-tool-class. Editing icon/colour is deferred.
import { DASH } from "../format";
import { toolIcons } from "../panels/rendered/chain";
import { CARD_KINDS, type CardKind } from "../panels/rendered/card-kinds";
import { addSettingRow, registerCategory } from "./registry";

const CARDS_CATEGORY = "cards";

/** The kind drawn as the chain draws it: icon then name, coloured by its data-tool-class, in the
 *  chain bar's frame. */
function sampleSegment(kind: CardKind): HTMLElement {
  const seg = document.createElement("span");
  seg.className = "chain-seg";
  seg.dataset.toolClass = kind.cls;
  seg.append(...toolIcons(kind.sample));
  const name = document.createElement("span");
  name.className = "chain-seg-name";
  name.textContent = kind.label;
  seg.appendChild(name);
  // the outline is the chain bar's, not the segment's (the segment draws only its class underline)
  const bar = document.createElement("span");
  bar.className = "activity-label chain-bar";
  bar.appendChild(seg);
  return bar;
}

/** The sample segment plus the wire names it covers, mono and dim. */
function kindControl(kind: CardKind): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cards-kind";
  const tools = document.createElement("span");
  tools.className = "cards-tools";
  tools.textContent = kind.tools.length ? kind.tools.join(" ") : DASH;
  wrap.append(tools, sampleSegment(kind)); // tools left, card right
  return wrap;
}

let registered = false;

/** Adds the Cards category once (ahead of Dependencies), one row per card kind. */
export function registerCardRows(): void {
  if (registered) return;
  registered = true;
  registerCategory(CARDS_CATEGORY, "Cards", "dependencies");
  for (const kind of CARD_KINDS) {
    addSettingRow({
      name: kind.label,
      tip: kind.tools.length ? `Covers ${kind.tools.join(", ")}.` : "Covers MCP tools and any tool not listed.",
      category: CARDS_CATEGORY,
      keywords: () => kind.tools.join(" "),
      control: () => kindControl(kind),
    });
  }
}
