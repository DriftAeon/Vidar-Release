/* Rendered transcript icons: svgEl and the tool-name to glyph table. The glyph geometry
   (lucide v1.44.0, ISC) lives in the shared table in `src/icons.ts`; only an inline <svg>
   can inherit `currentColor` from the row it sits in, so svgEl builds one with
   createElementNS — the same textContent-only trusted DOM path as el(), no innerHTML.
   Paths are read through lucidePath, which answers own keys only: the name can arrive
   from the agent stream, and a plain lookup would answer `constructor`/`toString`. */
import { lucidePath } from "../../icons";

const SVG_NS = "http://www.w3.org/2000/svg";export type IconName = "square-chart-gantt" | "square-chevron-right" | "square-terminal" | "square-pen" | "search-code" | "book-open"
  | "cpu" | "chevron-right" | "chevron-down" | "x" | "check" | "globe" | "folder-search"
  | "bot" | "clock" | "calendar" | "shield" | "minus" | "braces";

/** an inline lucide glyph that tints to the surrounding colour; `label` is its
 *  tooltip, so the word the icon replaced is still one hover away */
export function svgEl(name: IconName, label: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icn");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("role", "img");
  // <title> first: that is where browsers look for the native tooltip
  const t = document.createElementNS(SVG_NS, "title");
  t.textContent = label;
  svg.appendChild(t);
  for (const d of lucidePath(name) ?? []) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}
/** The two shell tools are most of the traffic and their names are the loudest
 *  thing on the row, so they become glyphs — everything else keeps its word, faded */
export const TOOL_ICON = new Map<string, IconName>([
  ["Bash", "square-chevron-right"],
  ["Command", "square-terminal"],
  ["PowerShell", "square-terminal"],
  ["Edit", "square-pen"],
  ["Grep", "search-code"],
  ["Read", "book-open"],
  ["Glob", "folder-search"],
  ["Write", "square-pen"],
  ["WebFetch", "globe"],
  ["WebSearch", "globe"],
  ["Agent", "bot"],
  ["Task", "bot"],
  ["SendMessage", "bot"],
  ["Wait", "bot"],
  ["CloseAgent", "bot"],
  ["InterruptAgent", "bot"],
  ["ListAgents", "bot"],
]);
