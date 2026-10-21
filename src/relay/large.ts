// Relay Open Large: one item shown in the left Relay pane (the session slot), under a bar with
// Back To Session, the kind chip, the title, the file name and its own action strip. The body is
// the one view pane (relay/view.ts). Nothing open large: the pane stays empty (2026-10-11).
// sessions.ts passes its functions in (hooks), so nothing here imports it (tests/import-cycles).

import { iconImg } from "../icon-img";
import { sessionTitle } from "../panels/sessions/lookup";
import { items as relayItems, type RelayItem } from "./store";
import { createRelayStrip, type RelayStrip } from "./strip";
import { mountRelayView, relayCurrent, relayViewState, showRelayItem } from "./view";

export interface RelayLargeHooks {
  /** empties the session slot and shows the Relay pane (sessions.ts openRelay) */
  openRelay(): void;
  activate(id: string): void;
  active(): string | null;
  /** Large opened or closed: the stack repaints which card is current */
  onChange(): void;
}

const KIND_CHIP = { display: "Display", ask: "Ask", card: "Approval" } as const;

let hooks: RelayLargeHooks | null = null;
let wrap: HTMLElement;
let backBtn: HTMLButtonElement;
let chipEl: HTMLElement;
let titleEl: HTMLElement;
let strip: RelayStrip;
let openId: string | null = null;
/** the tab Back To Session returns to: taken when Large goes from closed to open */
let prev: string | null = null;
/** the last tab a `vidar-focus` named; openRelay nulls the active id, so entering Relay from the
 *  left bar leaves this as the only record of the tab the user came from */
let lastFocusedId: string | null = null;

function span(cls: string): HTMLElement {
  const e = document.createElement("span");
  e.className = cls;
  return e;
}

function largeItem(): RelayItem | null {
  return openId === null ? null : relayItems().find((i) => i.id === openId) ?? null;
}

/** Mounts Large into the Relay pane. Its flex layout sits on an inner wrapper: sessions.ts sets
 *  the pane's own display inline. */
export function mountRelayLarge(pane: HTMLElement, h: RelayLargeHooks): void {
  hooks = h;
  wrap = document.createElement("div");
  wrap.className = "relay-large hidden";
  const bar = document.createElement("div");
  bar.className = "relay-lg-bar";
  backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "icon-btn file-action relay-act relay-back";
  backBtn.dataset.act = "back";
  backBtn.setAttribute("aria-label", "Back To Session");
  backBtn.title = "Back To Session";
  backBtn.appendChild(iconImg("back"));
  backBtn.addEventListener("click", () => back(true));
  chipEl = span("relay-chip");
  titleEl = span("relay-lg-title");
  const stripHost = document.createElement("div");
  bar.append(backBtn, span("relay-lg-sep"), chipEl, titleEl, stripHost);
  const body = document.createElement("div");
  body.className = "relay-pane";
  wrap.append(bar, body);
  pane.appendChild(wrap);
  strip = createRelayStrip(stripHost, { selected: largeItem, current: relayCurrent, view: relayViewState });
  mountRelayView(body, { onChange: () => strip.paint(), onAskNote: (m) => strip.note(m) });
  // Any layout with a tab on screen clears Large, not only a tab the user picked: every layout()
  // dispatches vidar-focus (a tab spawn, a tab closing). Acceptable: the next Open Large shows it again.
  document.addEventListener("vidar-focus", (e) => {
    const d = (e as CustomEvent<{ id: string } | null>).detail;
    if (!d) return;
    lastFocusedId = d.id;
    if (openId !== null) close(true);
  });
}

/** Shows `id` large in the session slot; the first open remembers the tab to go back to. */
export function openLarge(id: string): void {
  const item = relayItems().find((i) => i.id === id);
  if (!item || !hooks) return;
  if (openId === null) prev = hooks.active() ?? lastFocusedId;
  openId = id;
  hooks.openRelay();
  wrap.classList.remove("hidden");
  paintBar(item);
  void showRelayItem(item);
  hooks.onChange();
}

/** The item open large, or null. */
export function largeId(): string | null {
  return openId;
}

/** Store change: the open item repaints from its fresh entry (the view keys on mtime), or, gone
 *  (a verdict was given), Large closes and returns to the tab it came from. The caller repaints. */
export function syncLarge(list: readonly RelayItem[]): void {
  if (openId === null) return;
  const item = list.find((i) => i.id === openId);
  if (!item) { back(false); return; }
  paintBar(item);
  void showRelayItem(item);
}

function paintBar(item: RelayItem): void {
  chipEl.textContent = KIND_CHIP[item.kind];
  titleEl.textContent = item.title;
  titleEl.title = item.title;
  backBtn.disabled = !prev || sessionTitle(prev) === null;
  strip.paint();
}

function close(notify: boolean): void {
  openId = null;
  prev = null;
  wrap.classList.add("hidden");
  void showRelayItem(null);
  strip.paint();
  if (notify) hooks?.onChange();
}

function back(notify: boolean): void {
  const p = prev;
  close(notify);
  if (p && sessionTitle(p) !== null) hooks?.activate(p);
}
