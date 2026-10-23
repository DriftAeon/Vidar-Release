// One popover core for body-level menus and popups. openPopover shows `el` on body, places it, and
// closes it on:
// - an outside mousedown (capture phase, so a handler that stops propagation cannot keep it open);
//   `el`, `anchor` and every `inside()` node are exempt. The anchor exemption matters: without it the
//   mousedown closes and the click that follows reopens.
// - Escape, unless something already handled it (`defaultPrevented`: a nested menu closes alone);
//   Escape then calls `restoreFocus`.
// - a second openPopover (one open at a time), or the returned close function.
// The returned close is idempotent; `onClose(reason)` runs once, after the element is hidden or removed.
//
// Two shapes, picked for the menus that adopt this module:
// - persistent: true — for a menu element that lives in the DOM for good and is shown and hidden
//   (launcher/menu.ts #launcher-menu). Open drops the `hidden` class (appending to body only if the
//   element is detached), close adds it back; the element is never removed. External closers (the
//   launcher's setCloseLauncher / setHostedClose hooks) keep calling the consumer's own close
//   function, which calls the close this returns and does its column teardown in onClose. Flyout
//   columns outside `el` go through `inside`; keys from them reach the document, hence `keys: "document"`.
// - place: { x, y } — point placement at a pointer (character.ts view menu): top-left corner on the
//   point, clamped MENU_EDGE inside the window on both axes (placeMenu).
//   Otherwise `place` is a Placer from place-menu.ts (placeAbove, placeBeside) or the caller's own,
//   called with the attached element's size and the viewport; omitted, the caller positions `el`.
// No CSS or Tauri imports: jsdom tests load this and its callers.
import { placeMenu, type Placer } from "./place-menu";

export type PopoverCloseReason = "outside" | "escape" | "replaced" | "closed";

export interface PopoverOptions {
  /** the menu element; appended to body on open (persistent: only when detached) */
  el: HTMLElement;
  /** the control that opened it: its mousedown never closes (its click toggles instead) */
  anchor?: Element | null;
  /** a Placer, or a pointer point clamped on both axes; omitted, the caller positions `el` */
  place?: Placer | { x: number; y: number };
  /** nodes outside `el` whose mousedown must not close it (nested menus, launcher columns) */
  inside?: () => Node[];
  /** runs once after closing, with why */
  onClose?: (reason: PopoverCloseReason) => void;
  /** focus target on an Escape close, and on close(true): an element, or a function that moves focus */
  restoreFocus?: HTMLElement | (() => void) | null;
  /** keep `el` in the DOM, toggling the `hidden` class, instead of removing it on close */
  persistent?: boolean;
  /** where Escape is heard: on `el` (default; focus is inside the menu) or anywhere in the document */
  keys?: "el" | "document";
  /** keys other than Escape, from the same listener as Escape */
  onKey?: (e: KeyboardEvent) => void;
}

/** closes the popover; `refocus` also runs restoreFocus. A no-op once closed. */
export type ClosePopover = (refocus?: boolean) => void;

let current: { close: (reason: PopoverCloseReason, refocus: boolean) => void } | null = null;

/** closes whichever popover is open (a no-op when none is) */
export function closeOpenPopover(): void {
  current?.close("closed", false);
}

export function openPopover(o: PopoverOptions): ClosePopover {
  current?.close("replaced", false);
  const { el } = o;
  let off = () => {};
  let open = true;

  const refocus = () => {
    const f = o.restoreFocus;
    if (typeof f === "function") f();
    else f?.focus();
  };
  function close(reason: PopoverCloseReason, withFocus: boolean): void {
    if (!open) return;
    open = false;
    if (current === self) current = null;
    off();
    if (o.persistent) el.classList.add("hidden");
    else el.remove();
    if (withFocus) refocus();
    o.onClose?.(reason);
  }
  const self = { close };
  current = self;

  if (o.persistent) {
    if (!el.isConnected) document.body.append(el);
    el.classList.remove("hidden");
  } else {
    document.body.append(el);
  }
  placePopover(el, o.place);

  const onDown = (e: MouseEvent) => {
    const t = e.target as Node;
    if (el.contains(t) || o.anchor?.contains(t)) return;
    if (o.inside?.().some((n) => n.contains(t))) return;
    close("outside", false);
  };
  const onKeyDown = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (e.key === "Escape") {
      if (e.defaultPrevented) return; // a nested menu handled it and closes alone
      e.preventDefault();
      e.stopPropagation();
      close("escape", true);
    } else {
      o.onKey?.(e);
    }
  };
  // plain add/remove pairs, not an AbortSignal: the jsdom tests run Node's AbortController
  const keyTarget: EventTarget = o.keys === "document" ? document : el;
  document.addEventListener("mousedown", onDown, true);
  keyTarget.addEventListener("keydown", onKeyDown);
  off = () => {
    document.removeEventListener("mousedown", onDown, true);
    keyTarget.removeEventListener("keydown", onKeyDown);
  };

  return (withFocus = false) => close("closed", withFocus);
}

/** applies `place` to an attached element (also for a rerender that changed its size) */
export function placePopover(el: HTMLElement, place: PopoverOptions["place"]): void {
  if (!place) return;
  const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  const p = typeof place === "function" ? place(w, h, vw, vh) : placeMenu(place.x, place.y, w, h, vw, vh);
  el.style.left = `${p.left}px`;
  el.style.top = `${p.top}px`;
}
