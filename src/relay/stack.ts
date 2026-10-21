// Relay stack: the workbench tab body, one card per pending item, newest first (the store's order).
// Cards are keyed by item id and reused, so a repaint keeps focus, a typed comment and a painted
// thumbnail; a card is rebuilt when its view key changes (file mtime, ask hash) and disposed when
// its item leaves the store.

import { createRelayCard, type RelayCard, type RelayCardHooks } from "./card";
import type { RelayItem } from "./store";
import { relayViewKey } from "./view";

let stackEl: HTMLElement;
let hooks: RelayCardHooks;
const cards = new Map<string, RelayCard>();

export function mountRelayStack(host: HTMLElement, h: RelayCardHooks): HTMLElement {
  stackEl = host;
  hooks = h;
  return host;
}

/** `currentId`: the item open large, whose card carries `.current`. */
export function paintRelayStack(items: readonly RelayItem[], currentId: string | null): void {
  if (!stackEl) return;
  const live = new Map(items.map((i) => [i.id, i]));
  for (const [id, card] of cards) {
    const next = live.get(id);
    if (!next || relayViewKey(next) !== card.key) { card.dispose(); cards.delete(id); }
  }
  items.forEach((item, i) => {
    let card = cards.get(item.id);
    if (!card) { card = createRelayCard(item, hooks); cards.set(item.id, card); }
    card.update(item, item.id === currentId);
    // move only when out of place: re-inserting a focused card would drop its focus
    if (stackEl.children[i] !== card.el) stackEl.insertBefore(card.el, stackEl.children[i] ?? null);
  });
}
