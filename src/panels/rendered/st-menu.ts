// Status-bar popup of a Rendered body: the one small menu above a status-bar button that
// the mode and model pickers open; the open menu lives in `S.stMenu`.

import { btn, el } from "./dom";
import { chevronTile } from "./disc";
import type { RenderedState } from "./state";

export function createStMenu(S: RenderedState) {
  /* -- status-bar popup: one small menu above a status-bar button, used by the
        mode and model pickers (a popup, not a click-through cycle) -- */
  // every close path (row pick, outside click, reopen, dispose) goes through closeStMenu,
  // so the document listener can never outlive its menu
  let offAway: (() => void) | null = null;
  let openAnchor: HTMLElement | null = null;
  let openHost: HTMLElement | null = null;
  /** `refocus`: put focus back on the anchor pill (row pick, Escape, toggle); an outside click and dispose leave it alone */
  function closeStMenu(refocus = false) {
    offAway?.(); offAway = null;
    // the pill reads open while its menu is up (CSS: button.st-pill[aria-expanded="true"])
    if (openAnchor?.hasAttribute("aria-expanded")) openAnchor.setAttribute("aria-expanded", "false");
    // the pills are built once (status-bar.ts), so the anchor is still the live control
    const back = refocus ? openAnchor : null;
    openHost?.classList.remove("menu-open"); openHost = null;
    openAnchor = null;
    S.stMenu?.remove(); S.stMenu = null;
    if (back?.isConnected && !(back as HTMLButtonElement).disabled) back.focus();
  }
  function openStMenu(anchor: HTMLElement, items: { label: string; value: string; current?: boolean; group?: "legacy" }[], onPick: (value: string) => void) {
    // re-clicking the pill whose menu is open closes it
    if (S.stMenu && openAnchor === anchor) {
      closeStMenu(true);
      return;
    }
    closeStMenu();
    const menu = el("div", "st-menu");
    menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeStMenu(true); } });
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
    document.body.appendChild(menu);
    S.stMenu = menu;
    openAnchor = anchor;
    // the menu sits on body, outside the tab: keep the tab's focus ring while it is open (rendered-status.css)
    openHost = anchor.closest<HTMLElement>(".rendered"); // not .term-container: rendered-lockstep forbids host selectors in rendered-*.css
    openHost?.classList.add("menu-open");
    if (anchor.hasAttribute("aria-expanded")) anchor.setAttribute("aria-expanded", "true");
    // above the bar, left-aligned to the button; clamped to the window. The gap is measured from the
    // status bar's top divider, not the pill: the pill sits 4px inside the bar, so a pill-relative gap
    // put the menu's bottom edge on the divider (2026-10-04)
    const r = anchor.getBoundingClientRect();
    const barTop = (anchor.closest<HTMLElement>(".rendered-status") ?? anchor).getBoundingClientRect().top;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, barTop - menu.offsetHeight - 4)}px`;
    setTimeout(() => {
      if (S.stMenu !== menu) return; // closed before the opening click finished
      const away = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) closeStMenu(); };
      document.addEventListener("click", away);
      offAway = () => document.removeEventListener("click", away);
    }, 0);
    // focus starts on the ticked row, so the focus look never sits on Default while another model is current
    (menu.querySelector<HTMLButtonElement>(".menu-row.current:not([hidden])") ?? menu.querySelector<HTMLButtonElement>("button"))?.focus();
  }
  return { openStMenu, closeStMenu };
}
