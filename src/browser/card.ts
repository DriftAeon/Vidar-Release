// The inline card under an expanded row (look B), built on first open as in Runes (runes/cards.ts): a field
// bar from the row's own data with Send, Open in Browser and Fullscreen, then a body filled by
// `adapter.load`: a loader while it runs, then the excerpt and the newest comment line (each left out when
// empty), or the error title with its message as the tooltip.
import { lucide } from "../icons";
import { fieldBar, iconButton, node, sendButton } from "./list";
import type { Adapter, Detail, Item } from "./types";

export interface CardHooks {
  fullscreen(item: Item): void;
  /** False once the card was dropped or the browser disposed: a late load writes nothing. */
  alive(): boolean;
}

const FIRST_LINE = 200;

function commentLine(adapter: Adapter, d: Detail): HTMLElement | null {
  if (d.comments.total <= 0) return null;
  const line = node("div", "br-cline");
  line.append(lucide("message-square-text", "icn"), node("span", "br-n", String(d.comments.total)));
  const newest = d.comments.items[0];
  if (newest) {
    if (newest.author) line.appendChild(node("span", "br-who", newest.author));
    const text = adapter.rich.excerpt(newest.body, FIRST_LINE).split("\n")[0];
    if (text) line.appendChild(node("span", "br-ctext", text));
  }
  return line;
}

export function buildCard(adapter: Adapter, item: Item, h: CardHooks): HTMLElement {
  const card = node("div", "br-card");
  card.dataset.id = item.id;
  const bar = node("div", "br-card-bar");
  const acts = node("div", "br-acts");
  acts.append(
    sendButton("br-act", adapter.sendTip, () => adapter.send(item)),
    iconButton("br-act", { color: "globe" }, "Open in Browser", () => adapter.open(item)),
    iconButton("br-act", "maximize-2", "Fullscreen", () => h.fullscreen(item)),
  );
  bar.append(fieldBar(item.fields), acts);
  const body = node("div", "br-card-body");
  body.appendChild(lucide("loader-circle", "icn br-spin"));
  body.setAttribute("aria-busy", "true");
  card.append(bar, body);

  void adapter.load(item).then((r) => {
    if (!h.alive()) return;
    body.removeAttribute("aria-busy");
    body.replaceChildren();
    if ("error" in r) {
      const err = node("div", "br-err", r.error.title);
      err.title = r.error.message;
      body.appendChild(err);
      return;
    }
    if (r.ok.excerpt) body.appendChild(node("div", "br-excerpt", r.ok.excerpt));
    const line = commentLine(adapter, r.ok);
    if (line) body.appendChild(line);
  }, () => {
    if (h.alive()) body.replaceChildren();
  });
  return card;
}
