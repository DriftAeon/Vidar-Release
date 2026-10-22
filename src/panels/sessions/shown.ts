// What is on screen right now, set from sessions.ts layout(): the visible tab ids and whether the
// Relay pane can be seen (its slot, or the workbench that hosts its tab). A live binding, no DOM.

let ids: readonly string[] = [];
let relay = false;
const listeners = new Set<() => void>();

export function setShown(visible: readonly string[], relayOnScreen: boolean): void {
  ids = [...visible];
  relay = relayOnScreen;
  for (const fn of [...listeners]) fn();
}

export function shown(): { tabs: readonly string[]; relay: boolean } {
  return { tabs: ids, relay };
}

export function subscribeShown(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
