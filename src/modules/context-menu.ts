// Shared module action menu. Surface owners supply actions and keep ownership of state changes.
import "./context-menu.css";
import type { ModuleLevel } from "./types";
import { placeMenu } from "./place-menu";

export interface ModuleMenuAction {
  label: string;
  onSelect: () => void;
  /** Hide on a core module remains focusable so its reason can be announced. */
  level?: ModuleLevel;
  kind?: "hide" | "show" | "manage";
  disabled?: boolean;
  disabledReason?: string;
}

export interface ModuleMenuPosition {
  x?: number;
  y?: number;
  /** Keyboard menus in bars sit below the bar, not below one small control. */
  bar?: Element;
}

export interface ModuleContextMenu {
  close: () => void;
  isOpen: () => boolean;
}

let activeClose: (() => void) | undefined;

/** Key and focus trap shared by the module menu and the tab menu: a capture-phase outside click,
 *  focus leaving the menu, Escape, Tab, and Arrow/Home/End over `items()` (queried live).
 *  `onClose(restore)` is told whether focus should return to the opener (Escape, or a click
 *  outside while focus sat in the menu). Returns the disposer that removes the listeners. */
export function trapMenu(
  menu: HTMLElement,
  items: () => HTMLElement[],
  onClose: (restore: boolean) => void,
): () => void {
  function onOutside(event: MouseEvent): void {
    if (!menu.contains(event.target as Node)) onClose(menu.contains(document.activeElement));
  }
  function onFocusIn(event: FocusEvent): void {
    if (!menu.contains(event.target as Node)) onClose(false);
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if (event.key === "Tab") {
      onClose(false);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const list = items();
      if (!list.length) return;
      const index = list.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? list.length - 1
        : event.key === "ArrowDown" ? (index + 1) % list.length
        : (index - 1 + list.length) % list.length;
      list[next]?.focus();
    }
  }
  document.addEventListener("click", onOutside, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("keydown", onKey, true);
  return () => {
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

/** Opens one menu on the body; an existing module menu closes before the next opens. */
export function openModuleContextMenu(
  anchor: HTMLElement,
  actions: readonly ModuleMenuAction[],
  position: ModuleMenuPosition = {},
): ModuleContextMenu {
  activeClose?.();
  const container = anchor.parentElement;
  const ancestors: HTMLElement[] = [];
  for (let ancestor = container; ancestor; ancestor = ancestor.parentElement) ancestors.push(ancestor);
  const focusSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  /** Restore to the anchor, its container, or the nearest surviving ancestor. */
  function restoreFocus(): void {
    if (anchor.isConnected) { anchor.focus(); return; }
    const target = ancestors.find((ancestor) => ancestor.isConnected);
    if (!target) return;
    if (target === container) {
      const survivor = [...target.querySelectorAll<HTMLElement>(focusSelector)]
        .find((el) => !(el as HTMLButtonElement).disabled && !el.closest(".module-context-menu"));
      if (survivor) { survivor.focus(); return; }
    }
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus();
  }
  const menu = document.createElement("div");
  menu.className = "module-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Module Actions");

  let hasManageGap = false;
  const items = actions.map((action) => {
    if (action.kind === "manage" && !hasManageGap) {
      const gap = document.createElement("div");
      gap.className = "module-context-menu__gap";
      gap.setAttribute("role", "separator");
      menu.append(gap);
      hasManageGap = true;
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "module-context-menu__item";
    item.setAttribute("role", "menuitem");
    item.textContent = action.label;
    const coreHide = action.kind === "hide" && action.level === "core";
    if (action.disabled || coreHide) {
      item.setAttribute("aria-disabled", "true");
      item.setAttribute("aria-description", action.disabledReason ?? (coreHide ? "Core Module Always Shown" : "Unavailable"));
    }
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      if (item.getAttribute("aria-disabled") === "true") return;
      close(false);
      action.onSelect(); // Hide may remove the anchor; focus is settled after it ran
      restoreFocus();
    });
    menu.append(item);
    return item;
  });

  document.body.append(menu);
  const previousExpanded = anchor.getAttribute("aria-expanded");
  anchor.setAttribute("aria-expanded", "true");
  const rect = anchor.getBoundingClientRect();
  const barRect = position.bar?.getBoundingClientRect();
  const x = position.x ?? rect.left;
  const y = position.y ?? (barRect?.bottom ?? rect.bottom) + 4;
  const placed = placeMenu(x, y, menu.offsetWidth, menu.offsetHeight, window.innerWidth, window.innerHeight);
  menu.style.left = `${placed.left}px`;
  menu.style.top = `${placed.top}px`;
  items[0]?.focus();

  let open = true;
  const releaseTrap = trapMenu(menu, () => items, (restore) => close(restore));
  function close(restoreFocus = true): void {
    if (!open) return;
    open = false;
    releaseTrap();
    menu.remove();
    if (previousExpanded === null) anchor.removeAttribute("aria-expanded");
    else anchor.setAttribute("aria-expanded", previousExpanded);
    if (activeClose === closeWithoutFocus) activeClose = undefined;
    if (restoreFocus && anchor.isConnected) anchor.focus();
  }
  function closeWithoutFocus(): void { close(false); }
  activeClose = closeWithoutFocus;
  return { close, isOpen: () => open };
}

/** Adds mouse and keyboard context invocation to one control. Call dispose on unmount. */
export function bindModuleContextMenu(
  anchor: HTMLElement,
  actions: () => readonly ModuleMenuAction[],
  bar?: Element,
): () => void {
  const previousHasPopup = anchor.getAttribute("aria-haspopup");
  const previousExpanded = anchor.getAttribute("aria-expanded");
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "false");
  let current: ModuleContextMenu | undefined;
  function onContext(event: MouseEvent): void {
    event.preventDefault();
    current = openModuleContextMenu(anchor, actions(), { x: event.clientX, y: event.clientY });
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    event.preventDefault();
    current = openModuleContextMenu(anchor, actions(), { bar });
  }
  anchor.addEventListener("contextmenu", onContext);
  anchor.addEventListener("keydown", onKey);
  return () => {
    current?.close();
    anchor.removeEventListener("contextmenu", onContext);
    anchor.removeEventListener("keydown", onKey);
    if (previousHasPopup === null) anchor.removeAttribute("aria-haspopup");
    else anchor.setAttribute("aria-haspopup", previousHasPopup);
    if (previousExpanded === null) anchor.removeAttribute("aria-expanded");
    else anchor.setAttribute("aria-expanded", previousExpanded);
  };
}
