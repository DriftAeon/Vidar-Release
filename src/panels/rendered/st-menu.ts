// Status-bar popup of a Rendered body: the one small menu above a status-bar button that
// the mode and model pickers open; the open menu lives in `S.stMenu`.

import { btn, el } from "./dom";
import { chevronTile } from "./disc";
import { openPopover } from "../../modules/popover";
import { placeAbove } from "../../modules/place-menu";
import type { RenderedState } from "./state";

export function createStMenu(S: RenderedState) {
  /* -- status-bar popup: one small menu above a status-bar button, used by the
        mode and model pickers (a popup, not a click-through cycle) -- */
  // the popover core (modules/popover.ts) owns outside-click and Escape; every close path
  // (row pick, outside click, Escape, reopen, dispose) ends in its onClose below
  let closePop: ((refocus?: boolean) => void) | null = null;
  let openAnchor: HTMLElement | null = null;
  let openHost: HTMLElement | null = null;
  /** `refocus`: put focus back on the anchor pill (row pick, Escape, toggle); an outside click and dispose leave it alone */
  function closeStMenu(refocus = false) {
    closePop?.(refocus);
  }
  function teardown(menu: HTMLElement) {
    if (S.stMenu !== menu) return;
    closePop = null;
    // the pill reads open while its menu is up (CSS: button.st-pill[aria-expanded="true"])
    if (openAnchor?.hasAttribute("aria-expanded")) openAnchor.setAttribute("aria-expanded", "false");
    openHost?.classList.remove("menu-open"); openHost = null;
    openAnchor = null;
    S.stMenu = null;
  }
  function openStMenu(anchor: HTMLElement, items: { label: string; value: string; current?: boolean; group?: "legacy" }[], onPick: (value: string) => void) {
    // re-clicking the pill whose menu is open closes it
    if (S.stMenu && openAnchor === anchor) {
      closeStMenu(true);
      return;
    }
    closeStMenu();
    const menu = el("div", "st-menu");
    const legacy: HTMLButtonElement[] = [];
    const rowFor = (it: (typeof items)[number]) =>
      btn(it.label, `menu-row${it.current ? " current" : ""}`, () => { closeStMenu(true); onPick(it.value); });
    for (const it of items) if (it.group !== "legacy") menu.appendChild(rowFor(it));
    const legacyItems = items.filter((it) => it.group === "legacy");
    if (legacyItems.length) {
      const toggle = btn("", "menu-row menu-group", () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(open));
        for (const b of legacy) b.hidden = !open;
      });
      toggle.append(el("span", "", "Legacy"), chevronTile("caret"));
      menu.appendChild(toggle);
      const startOpen = legacyItems.some((it) => it.current);
      toggle.setAttribute("aria-expanded", String(startOpen));
      for (const it of legacyItems) {
        const b = rowFor(it);
        b.hidden = !startOpen;
        legacy.push(b);
        menu.appendChild(b);
      }
    }
    S.stMenu = menu;
    openAnchor = anchor;
    // the menu sits on body, outside the tab: keep the tab's focus ring while it is open (rendered-status.css)
    openHost = anchor.closest<HTMLElement>(".rendered"); // not .term-container: rendered-lockstep forbids host selectors in rendered-*.css
    openHost?.classList.add("menu-open");
    if (anchor.hasAttribute("aria-expanded")) anchor.setAttribute("aria-expanded", "true");
    // above the bar, left-aligned to the button; clamped to the window. The gap is measured from the
    // status bar's top divider, not the pill: the pill sits 4px inside the bar, so a pill-relative gap
    // put the menu's bottom edge on the divider (2026-10-04)
    const bar = anchor.closest<HTMLElement>(".rendered-status") ?? anchor;
    closePop = openPopover({
      el: menu,
      anchor,
      place: placeAbove(anchor.getBoundingClientRect(), bar.getBoundingClientRect(), "start"),
      restoreFocus: anchor,
      onClose: () => teardown(menu),
    });
    // focus starts on the ticked row, so the focus look never sits on Default while another model is current
    (menu.querySelector<HTMLButtonElement>(".menu-row.current:not([hidden])") ?? menu.querySelector<HTMLButtonElement>("button"))?.focus();
  }
  return { openStMenu, closeStMenu };
}
