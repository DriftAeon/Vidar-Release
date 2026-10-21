// The open body of a successful Edit/Write/MultiEdit pill: the changed lines (+ green, − red,
// first EDIT_DIFF_CAP then "+N More Lines"), "+a −b" counts in the summary row, and the
// structured result behind a braces button left of the mark. Text only via textContent.

import { el } from "./dom";
import { svgEl } from "./icons";
import { pretty } from "./format";
import { diffSpan } from "./approval-detail";
import { editDiff, type DiffLine } from "./edit-diff";

const lineSpan = (l: DiffLine) => diffSpan(l.kind, l.text, "", "edit-line");

/** Build the line list into `details` (a done pill). false = nothing to list; the caller
 *  shows the raw output instead. `structuredMax` caps the structured JSON like the output. */
export function editPillBody(details: HTMLDetailsElement, structured: unknown, structuredMax: number): boolean {
  const d = editDiff(structured);
  if (!d) return false;
  // the line list replaces the raw input JSON toolStart drew
  details.querySelector(":scope > pre.tool-input")?.remove();
  const list = el("div", "edit-diff");
  list.append(...d.shown.map(lineSpan));
  if (d.rest.length) {
    const more = el("details", "edit-more");
    more.append(el("summary", "", `+${d.rest.length} More Lines`));
    // the rest is drawn on first open: a large Write would otherwise build every span up front
    more.addEventListener("toggle", () => {
      if (more.open && more.childElementCount === 1) more.append(...d.rest.map(lineSpan));
    });
    list.append(more);
  }
  details.appendChild(list);

  const summary = details.querySelector<HTMLElement>(":scope > summary");
  const mark = summary?.querySelector(":scope > .mark") ?? null;
  const counts = el("span", "edit-counts");
  if (d.added) counts.append(el("span", "diff-add", `+${d.added}`));
  if (d.removed) counts.append(el("span", "diff-del", `−${d.removed}`));
  summary?.insertBefore(counts, mark);

  // structured result: its own summary hidden, opened by the braces button in the pill's row
  const sd = el("details", "tool-structured via-icon");
  sd.append(el("summary", "", "Structured Result"));
  // the JSON is built on first open, like the rest: a closed pill holds no pretty-printed copy
  const pre = el("pre", "");
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    const js = pretty(structured);
    pre.textContent = js.length > structuredMax ? js.slice(0, structuredMax) + "\n… (more)" : js;
  };
  sd.append(pre);
  details.appendChild(sd);
  const toggle = el("button", "tool-structured-btn");
  toggle.type = "button";
  toggle.title = "Structured Result";
  toggle.setAttribute("aria-label", "Structured Result");
  toggle.setAttribute("aria-expanded", "false");
  toggle.appendChild(svgEl("braces", "Structured Result"));
  // inside the summary: the click must not also fold the pill
  toggle.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fill(); sd.open = !sd.open; });
  sd.addEventListener("toggle", () => {
    if (sd.open) fill();
    toggle.setAttribute("aria-expanded", String(sd.open));
    toggle.classList.toggle("on", sd.open);
  });
  summary?.insertBefore(toggle, mark);
  return true;
}
