// Delete Flow confirm: the Swap Confirm card (head, body, actions; menus.css, bar-switches.css)
// fixed on the body above the Flow picker menu, with the shared decision pair: Delete on the red
// deny fill, Cancel neutral (decision-pair.css). Esc, Cancel and an outside mousedown close it;
// Esc and Cancel hand focus back to `returnTo`. The picker owns the delete itself (`onDelete`).

import { iconImg } from "../icon-img";

const TITLE = "Delete Flow?";

let card: HTMLDivElement | null = null;
let offListeners: (() => void) | null = null;

/** The open card, for the picker menu's outside-mousedown check. */
export function deleteConfirmEl(): HTMLElement | null {
  return card;
}

export function closeDeleteConfirm(): void {
  offListeners?.();
  offListeners = null;
  card?.remove();
  card = null;
}

/** Opens the card under `anchor` (the User row), clamped inside the viewport, focus on Cancel. */
export function openDeleteConfirm(anchor: HTMLElement, name: string, onDelete: () => void, returnTo: HTMLElement): void {
  closeDeleteConfirm();
  const box = document.createElement("div");
  box.id = "flow-delete-confirm";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", TITLE);
  const head = document.createElement("div");
  head.className = "swap-confirm-head";
  const tile = document.createElement("span");
  tile.className = "title-tile"; // title-bar.css
  tile.append(iconImg("trash"));
  const strong = document.createElement("strong");
  strong.textContent = TITLE;
  head.append(tile, strong);
  const body = document.createElement("div");
  body.className = "swap-confirm-body";
  const text = document.createElement("p");
  text.textContent = `${name} will be deleted. Its runs are kept.`;
  const actions = document.createElement("div");
  actions.className = "swap-confirm-actions";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "swap-yes";
  yes.textContent = "Delete";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "swap-no";
  no.textContent = "Cancel";
  const cancel = () => {
    closeDeleteConfirm();
    returnTo.focus();
  };
  yes.addEventListener("click", () => {
    closeDeleteConfirm();
    onDelete();
  });
  no.addEventListener("click", cancel);
  actions.append(yes, no);
  body.append(text, actions);
  box.append(head, body);
  document.body.append(box);
  card = box;

  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - box.offsetHeight - 8))}px`;

  // Capture phase: Esc here must not also reach the picker menu's own Escape (which closes it).
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const onOutside = (e: MouseEvent) => {
    if (!box.contains(e.target as Node)) closeDeleteConfirm();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onOutside, true);
  offListeners = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
  };
  no.focus();
}
