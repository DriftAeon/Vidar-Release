/* Rendered transcript icons: the inline lucide glyphs (geometry and svgEl) and the
   tool-name to glyph table. */

/* Inline icons (lucide v1.44.0, ISC). The geometry comes from the copies in
   `public/icons/` — those files are the provenance and the licence. Path data is
   verbatim except where noted below: the square outlines are a <rect> in the
   source, converted here to an equivalent path. The renderer inlines the geometry
   because only an inline <svg> can inherit `currentColor` from the row it sits in
   (an <img> cannot be tinted). Built with createElementNS, so this stays on the same
   textContent-only trusted DOM path as el() — no innerHTML anywhere in this file. */
const SVG_NS = "http://www.w3.org/2000/svg";
/* Maps, not object literals: both tables are keyed by a tool name that arrives from
   the agent stream, and a plain object answers `constructor`/`toString` with an
   inherited value — a tool called that would have looked up a glyph and then thrown
   on absent path data instead of falling back to its word. */
export type IconName = "square-chart-gantt" | "square-chevron-right" | "square-terminal" | "square-pen" | "search-code" | "book-open"
  | "cpu" | "chevron-right" | "chevron-down" | "x" | "check" | "globe" | "folder-search"
  | "message-circle-question" | "bot" | "clock" | "calendar" | "shield" | "minus" | "braces";
/* Both square glyphs share one outline: lucide draws it as
   <rect x=3 y=3 w=18 h=18 rx=2 ry=2>, written here as the equivalent rounded-rect
   path so svgEl only ever has to emit <path> elements. This is the one place the
   geometry is NOT verbatim from `public/icons/`. */
const SQUARE_OUTLINE = "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z";
const ICON_PATHS = new Map<IconName, readonly string[]>([
  /* Thinking: lucide square-chart-gantt — three bars verbatim
     from lucide, frame is the shared rounded rect. */
  ["square-chart-gantt", [
    "M9 8h7",
    "M8 12h6",
    "M11 16h5",
    SQUARE_OUTLINE,
  ]],
  ["square-chevron-right", [
    "m10 8 4 4-4 4",
    SQUARE_OUTLINE,
  ]],
  ["square-terminal", [
    "m7 11 2-2-2-2",
    "M11 13h4",
    SQUARE_OUTLINE,
  ]],
  /* Both paths verbatim from public/icons/square-pen.svg: its frame is NOT SQUARE_OUTLINE —
     lucide opens the top-right corner so the pen can cross it, so the shared rect is wrong here. */
  ["square-pen", [
    "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
    "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
  ]],
  /* The three chevron/bar strokes are verbatim from public/icons/search-code.svg; its lens is
     the second place the geometry is NOT verbatim — lucide draws it as <circle cx=11 cy=11 r=8>
     and svgEl only emits <path>, so it is written here as the equivalent two-arc path. */
  ["search-code", [
    "m13 13.5 2-2.5-2-2.5",
    "m21 21-4.3-4.3",
    "M9 8.5 7 11l2 2.5",
    "M19 11a8 8 0 1 1-16 0 8 8 0 1 1 16 0z",
  ]],
  /* Both paths verbatim from public/icons/book-open.svg. */
  ["book-open", [
    "M12 5v16",
    "M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z",
  ]],
  /* Rendered redesign set (lucide v1.44.0, ISC; geometry from public/icons/lucide/<name>.svg).
     Paths are verbatim; every <circle> and <rect> in a source is written here as the equivalent
     arc / rounded-rect path (same precedent as SQUARE_OUTLINE and search-code above), so these
     entries are the other places the geometry is NOT verbatim. */
  /* cpu: the 12 pin strokes verbatim; <rect 4,4,16,16 rx2> and <rect 8,8,8,8 rx1> as paths. */
  ["cpu", [
    "M12 20v2", "M12 2v2", "M17 20v2", "M17 2v2", "M2 12h2", "M2 17h2", "M2 7h2",
    "M20 12h2", "M20 17h2", "M20 7h2", "M7 20v2", "M7 2v2",
    "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    "M9 8h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z",
  ]],
  ["chevron-right", ["m9 18 6-6-6-6"]],
  ["chevron-down", ["m6 9 6 6 6-6"]],
  ["x", ["M18 6 6 18", "m6 6 12 12"]],
  ["check", ["M20 6 9 17l-5-5"]],
  ["minus", ["M5 12h14"]],
  /* braces: both paths verbatim from public/icons/lucide/braces.svg. */
  ["braces", [
    "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1",
    "M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1",
  ]],
  /* globe: <circle 12,12,r10> as an arc path; meridian and equator verbatim. */
  ["globe", [
    "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
    "M2 12h20",
    "M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0z",
  ]],
  /* folder-search: <circle 17,17,r3> as an arc path. */
  ["folder-search", [
    "M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1",
    "m21 21-1.9-1.9",
    "M20 17a3 3 0 1 1-6 0 3 3 0 1 1 6 0z",
  ]],
  /* message-circle-question: all three paths verbatim. */
  ["message-circle-question", [
    "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",
    "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3",
    "M12 17h.01",
  ]],
  /* bot: <rect x4 y8 w16 h12 rx2> as a path; the rest verbatim. */
  ["bot", [
    "M12 8V4H8",
    "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z",
    "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2",
  ]],
  /* clock: <circle 12,12,r10> as an arc path. */
  ["clock", [
    "M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0z",
    "M12 6v6l4 2",
  ]],
  /* calendar: <rect 3,3,18,18 rx2> is SQUARE_OUTLINE. */
  ["calendar", [
    "M8 2v3", "M16 2v3", "M3 9h18",
    SQUARE_OUTLINE,
  ]],
  ["shield", [
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
  ]],
]);

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
  for (const d of ICON_PATHS.get(name) ?? []) {
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
