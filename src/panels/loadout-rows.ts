// Shared Loadout row structure and small detail builders for Claude and Codex.
import { iconImg, type ColorIcon } from "../icon-img";
import { rackRow, text } from "./rack-row";

// same shape as detailRow, but the value is a caller-built node (a path span
// carrying a title, an ellipsis span, etc.)
export const detailRowNode = (k: string, valueNode: HTMLElement) => {
  const r = document.createElement("div");
  r.className = "row";
  r.append(text("", k), valueNode);
  return r;
};

// the rack-scope slot: one compact value, optionally a dim "+extra" suffix
// and/or a title tooltip
export function scopeValue(value: string, extra?: string, title?: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "rack-scope";
  el.append(document.createTextNode(value));
  if (extra) el.append(text("dim", ` +${extra}`));
  if (title) el.title = title;
  return el;
}

// one helper for every path shown in the module: `C:\Users\<name>\...` -> `~\...`,
// or the focused tab's cwd prefix -> `.\...`; full path always survives in title
export function shortenPath(full: string, cwd?: string | null): string {
  if (cwd) {
    const norm = cwd.replace(/[\\/]+$/, "");
    if (full.toLowerCase().startsWith(norm.toLowerCase())) {
      const rest = full.slice(norm.length).replace(/^[\\/]+/, "");
      return rest ? `.\\${rest}` : ".";
    }
  }
  const home = /^[A-Za-z]:\\Users\\[^\\]+/.exec(full);
  if (home) return `~${full.slice(home[0].length)}`;
  return full;
}

export function pathNode(full: string, cwd?: string | null): HTMLElement {
  const el = text("loadout-ellipsis loadout-mono", shortenPath(full, cwd));
  el.title = full;
  return el;
}

export function infoLine(icon: ColorIcon, value: HTMLElement, title: string): HTMLElement {
  const line = document.createElement("div");
  line.className = "loadout-info-line";
  const image = iconImg(icon);
  image.title = title;
  line.append(image, value);
  return line;
}

export function groupHead(icon: ColorIcon, label: string, title: string): HTMLElement {
  const head = infoLine(icon, text("", label), title);
  head.classList.add("loadout-group-head");
  head.title = title;
  return head;
}

export function groupedLines(head: HTMLElement, lines: HTMLElement[]): HTMLElement {
  const group = document.createElement("div");
  group.className = "loadout-group";
  group.append(head, ...lines);
  return group;
}

/** a row's open toggle, so a redraw can re-open the rows that were open (no synthetic click) */
export const rowToggles = new WeakMap<HTMLElement, () => void>();

// Gear section icons, left of the label (2026-10-13); Launch has none.
export const ROW_ICONS: Partial<Record<string, ColorIcon>> = {
  Instructions: "rules",
  Memory: "memory-card",
  Agents: "agent",
  Skills: "skill",
  Config: "ruler",
  Hooks: "hook",
  Permissions: "ruler",
};

// collapsible row, same shape as rack.ts's server rows (rack-row/rack-name/rack-detail);
// valueNode is the rack-scope slot the caller built (scopeValue(...) in the common case).
// `empty`: a section with nothing to show is hidden (the row stays in the DOM, `hidden`, so a repaint with entries reveals it).
export function buildRow(label: string, valueNode: HTMLElement, detailBuilder: () => HTMLElement[], empty = false): HTMLElement {
  let built = false;
  const icon = ROW_ICONS[label];
  const { row, detail, toggle } = rackRow({
    key: label,
    inert: empty,
    nameParts: [...(icon ? [iconImg(icon)] : []), text("rack-label", label), valueNode],
    onOpen: () => {
      if (built) return;
      built = true;
      detail.append(...detailBuilder());
    },
  });
  rowToggles.set(row, toggle);
  row.hidden = empty; // nothing to expand: not drawn at all until entries arrive
  return row;
}
