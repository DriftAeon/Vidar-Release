// One expandable rack row (.rack-row > button.rack-name + .rack-detail) shared by Gear
// (loadout.ts), the MCP rack (rack.ts) and the LM Studio row. Callers keep their own
// extras (dataset, classes, titles) and their own "loaded" flags: onOpen fires on every open.

import { onPress } from "./press";

// Every field is config-supplied, so all of it goes in as text and none of it as markup.
export const text = (cls: string, s: string) => {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = s;
  return el;
};

export const detailRow = (k: string, v: string) => {
  const r = document.createElement("div");
  r.className = "row";
  r.append(text("", k), text("", v));
  return r;
};

export interface RackRow {
  row: HTMLElement;
  name: HTMLButtonElement;
  detail: HTMLElement;
  toggle: () => void;
}

export function rackRow(opts: { key: string; nameParts: (Node | string)[]; onOpen?: () => void; inert?: boolean }): RackRow {
  const row = document.createElement("div");
  row.className = "rack-row";
  row.dataset.key = opts.key; // reorder.ts
  const name = document.createElement("button");
  name.className = "rack-name";
  // inert: nothing to open, so no toggle and no aria-expanded; aria-disabled, not `disabled` (that dims the row)
  if (opts.inert) name.setAttribute("aria-disabled", "true"); else name.setAttribute("aria-expanded", "false");
  name.append(...opts.nameParts);
  const detail = document.createElement("div");
  detail.className = "rack-detail collapsed"; // modules.css slides it; not .hidden (display none cannot animate)
  const toggle = () => {
    if (opts.inert) return;
    const open = detail.classList.toggle("collapsed") === false;
    row.classList.toggle("open", open);
    name.setAttribute("aria-expanded", String(open));
    if (open) opts.onOpen?.();
  };
  if (!opts.inert) onPress(name, toggle);
  row.append(name, detail);
  return { row, name, detail, toggle };
}
