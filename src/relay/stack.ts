// Relay stack: the workbench tab body, one card per pending item, newest first (the store's order).
// Cards are keyed by item id and reused, so a repaint keeps focus, a typed comment and a painted
// thumbnail; a card is rebuilt when its view key changes (file mtime, ask hash) and disposed when
// its item leaves the store. An ask card whose item leaves without Relay answering it waits LINGER_MS
// for the asker's tab to report the answer (ASK_SETTLED_EVENT): a settled card shows its answered state
// until its own timer ends (card-ask-state.ts), an unsettled one goes at the end of the wait.

import { createRelayCard, type RelayCard, type RelayCardHooks } from "./card";
import type { RelayItem } from "./store";
import { relayViewKey } from "./view";

/** the wait for the tab's settled event after the store drops an ask */
const LINGER_MS = 1500;

interface Gone { card: RelayCard; at: number; timer: ReturnType<typeof setTimeout> }

let stackEl: HTMLElement;
let hooks: RelayCardHooks;
const cards = new Map<string, RelayCard>();
/** cards whose item left the store but may still show an answered state */
const gone = new Map<string, Gone>();
/** settled cards that showed long enough while their item is still in the store */
const done = new Set<string>();

export function mountRelayStack(host: HTMLElement, h: RelayCardHooks): HTMLElement {
  stackEl = host;
  hooks = {
    ...h,
    onSettledDone: (id) => {
      const g = gone.get(id);
      if (g) { clearTimeout(g.timer); g.card.dispose(); gone.delete(id); return; }
      const c = cards.get(id);
      if (c) { c.dispose(); cards.delete(id); done.add(id); }
      h.onSettledDone?.(id);
    },
  };
  return host;
}

function drop(id: string): void {
  const g = gone.get(id);
  if (!g) return;
  clearTimeout(g.timer);
  if (!g.card.settled()) { g.card.dispose(); gone.delete(id); } // a settled card ends on its own timer
}

/** `currentId`: the item open large, whose card carries `.current`. */
export function paintRelayStack(items: readonly RelayItem[], currentId: string | null): void {
  if (!stackEl) return;
  const live = new Map(items.map((i) => [i.id, i]));
  for (const id of done) if (!live.has(id)) done.delete(id);
  const slots: { id: string; card: RelayCard | null; item: RelayItem | null }[] = [];
  const kids = [...stackEl.children];
  for (const [id, card] of cards) {
    const next = live.get(id);
    if (next && relayViewKey(next) === card.key) continue;
    cards.delete(id);
    if (!next && (card.lingers() || card.settled())) {
      gone.set(id, { card, at: kids.indexOf(card.el), timer: setTimeout(() => drop(id), LINGER_MS) });
    } else {
      card.dispose();
    }
  }
  for (const [id, g] of gone) if (live.has(id)) { clearTimeout(g.timer); g.card.dispose(); gone.delete(id); } // came back
  const order = items.filter((i) => !done.has(i.id)).map((i) => i.id);
  for (const id of order) slots.push({ id, card: null, item: live.get(id) ?? null });
  // a card on its way out keeps its old place
  for (const [id, g] of [...gone].sort((a, b) => a[1].at - b[1].at)) slots.splice(Math.min(Math.max(g.at, 0), slots.length), 0, { id, card: g.card, item: null });
  slots.forEach((slot, i) => {
    let card = slot.card;
    if (!card && slot.item) {
      card = cards.get(slot.id) ?? createRelayCard(slot.item, hooks);
      cards.set(slot.id, card);
      card.update(slot.item, slot.id === currentId);
    }
    if (!card) return;
    // move only when out of place: re-inserting a focused card would drop its focus
    if (stackEl.children[i] !== card.el) stackEl.insertBefore(card.el, stackEl.children[i] ?? null);
  });
}
