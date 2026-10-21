// Relay views: the left-pane view (Relay button) and the workbench tab body.
// The tab is wiring only: a stack of item cards, fed by the relay store; the parts live in
// src/relay/. The left pane shows one item large (Open Large) with Back To Session, and stays
// empty with nothing open large (layout A, user 2026-10-07; c286c382).

import { items as relayItems, subscribe, markSeen, isUnread, type RelayItem } from "../relay/store";
import { paintRelayRow } from "./sessions/tab-row-paint";
import { startDisplaySource, refresh } from "../relay/source-display";
import { startAskSource, refresh as refreshAsks } from "../relay/source-asks";
import { setAskVisible } from "../relay/ask-view";
import { mountRelayStack, paintRelayStack } from "../relay/stack";
import { mountRelayLarge, openLarge, largeId, syncLarge } from "../relay/large";

/** sessions.ts's own functions, passed in: importing it from here would grow the import cycle */
export interface RelayPaneHooks {
  openRelay(): void;
  activate(id: string): void;
  active(): string | null;
}

/** Left-pane view: fills the terminal slot when the Relay button is pressed; holds Open Large. */
export function mountRelayPane(parent: HTMLElement, hooks: RelayPaneHooks): HTMLElement {
  const pane = document.createElement("div");
  pane.className = "term-container term-relay pane-left";
  pane.style.order = "0"; // left of the split grip (order 1), like a real left pane
  pane.style.display = "none";
  parent.appendChild(pane);
  mountRelayLarge(pane, { ...hooks, onChange: () => { if (tabEl) render(); } });
  return pane;
}

let tabEl: HTMLElement | undefined;
/** workbench shown AND Relay the active tab */
let onScreen = false;
let notifyFn: (unseen: boolean) => void = () => {};
let started = false;
let renderQueued = false;

/** A card came into view: seen only while the tab is on screen; off screen it stays unread. */
function cardVisible(id: string): void {
  if (!onScreen || !isUnread(id)) return;
  markSeen(id);
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => { renderQueued = false; render(); });
}

/** Workbench tab body: the card stack. `notify(unseen)` dots the tab while an unread item waits
 *  and Relay is not on screen. */
export function mountRelayTab(parent: HTMLElement, notify: (unseen: boolean) => void): HTMLElement {
  notifyFn = notify;
  const el = document.createElement("div");
  tabEl = el;
  el.id = "relay-view";
  el.style.display = "none";
  el.innerHTML = `<div class="relay-stack"></div>`;
  mountRelayStack(el.querySelector<HTMLElement>(".relay-stack")!, { openLarge, onVisible: cardVisible });
  parent.appendChild(el);
  subscribe(apply);
  if (!started) {
    started = true;
    startDisplaySource();
    startAskSource();
  }
  apply(relayItems());
  return el;
}

/** Store change: the item open large repaints, or closes once it has gone. */
function apply(list: readonly RelayItem[]) {
  syncLarge(list);
  render();
}

function render() {
  if (!tabEl) return;
  const list = relayItems();
  // empty: nothing at all, no placeholder
  tabEl.classList.toggle("relay-empty", list.length === 0);
  paintRelayStack(list, largeId());
  setRelayAlert(list.length > 0);
  paintRelayRow(list);
  notifyFn(!onScreen && list.some((i) => isUnread(i.id)));
}

/** The tab is on screen: the tab dot clears for the cards in view, and the list is re-read (an
 *  outside sidecar write never emits display-update). */
export function onRelayShown(): void {
  onScreen = true;
  render();
  setAskVisible(true);
  void refresh().catch(() => {});
  void refreshAsks().catch(() => {});
}

/** The tab left the screen: new arrivals dot the tab again. */
export function onRelayHidden(): void {
  setAskVisible(false);
  onScreen = false;
  render();
}

/** Flips the left-bar icon between mail and mail-alert. */
function setRelayAlert(on: boolean): void {
  document.getElementById("relay-btn")?.classList.toggle("alert", on);
}
