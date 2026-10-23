// One dropdown model for the body-appended pickers (Display file picker, Document Open, Flow
// picker and New): the popover core (modules/popover.ts) plus button wiring. The menu element
// exists only while open, an outside mousedown (capture phase) closes it, Escape closes and
// refocuses the button, Tab refocuses the button and then closes so focus moves on natively,
// ArrowDown on the button opens. Opening another popover closes this one. Rows, row keys and
// focus targets stay with each caller. No CSS or Tauri imports: the jsdom tests load its callers
// (document-open-menu.ts, flow-picker.ts).
import { openPopover, type ClosePopover } from "../modules/popover";

export interface DropdownOptions {
  button: HTMLButtonElement;
  /** element whose bottom edge places the menu (left always follows the button) */
  anchor: Element | (() => Element);
  /** fills `menu`; `opening` is true on a fresh menu (before it is in the DOM), false on rerender */
  build: (menu: HTMLDivElement, opening: boolean) => void;
  /** keys on the menu element other than Escape and Tab */
  onKey?: (e: KeyboardEvent, menu: HTMLDivElement) => void;
  /** nodes outside the menu whose mousedown must not close it (Display: the row menu) */
  inside?: () => Node[];
  /** clamp the top at 8 px too (Flow) */
  floor?: boolean;
  /** after open (byKey false: click) and on ArrowDown from the button (byKey true): focus a row */
  enter?: (menu: HTMLDivElement, byKey: boolean) => void;
}

export interface Dropdown {
  open: (byKey?: boolean) => void;
  close: () => void;
  isOpen: () => boolean;
  /** re-runs `build` on the open menu; a no-op while closed (focus is the build's to keep) */
  rerender: () => void;
}

/** Places a body-appended, already-attached `m` 4 px under `anchor`, left-aligned with `button`,
 *  clamped 8 px inside the viewport (top floored at 8 only with `floor`). */
export function placeBelow(m: HTMLElement, button: Element, anchor: Element = button, floor = false): void {
  const r = button.getBoundingClientRect();
  const bottom = anchor === button ? r.bottom : anchor.getBoundingClientRect().bottom;
  m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8))}px`;
  const top = Math.min(bottom + 4, window.innerHeight - m.offsetHeight - 8);
  m.style.top = `${floor ? Math.max(8, top) : top}px`;
}

export function dropdown(o: DropdownOptions): Dropdown {
  const { button } = o;
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  let menu: HTMLDivElement | null = null;
  let dispose: ClosePopover | null = null;

  function close(): void {
    dispose?.();
  }

  function open(byKey = false): void {
    if (menu) return;
    const m = document.createElement("div");
    menu = m;
    o.build(m, true);
    // the core does outside mousedown (button exempt as the anchor), Escape and its refocus
    dispose = openPopover({
      el: m,
      anchor: button,
      inside: o.inside,
      restoreFocus: button,
      onKey: (e) => {
        if (e.key === "Tab") {
          button.focus(); // let focus move on natively from the button
          close();
        } else {
          o.onKey?.(e, m);
        }
      },
      onClose: () => {
        menu = null;
        dispose = null;
        button.setAttribute("aria-expanded", "false");
      },
    });
    button.setAttribute("aria-expanded", "true");
    placeBelow(m, button, typeof o.anchor === "function" ? o.anchor() : o.anchor, o.floor);
    o.enter?.(m, byKey);
  }

  function rerender(): void {
    if (menu) o.build(menu, false);
  }

  button.addEventListener("click", () => (menu ? close() : open()));
  // native Enter/Space already fire click on a <button>: no keydown for them, or it toggles twice
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!menu) open(true);
      else o.enter?.(menu, true);
    } else if (e.key === "Escape" && menu) {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab" && menu) {
      close();
    }
  });

  return { open, close, isOpen: () => !!menu, rerender };
}
