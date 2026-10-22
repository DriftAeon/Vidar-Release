/* Shared Lucide glyphs as inline SVG (stroke = currentColor, so they take the
   button's colour). Path data from lucide-static 1.44.0 (bridge\lucide-static-1.44.0.tgz).
   rendered/icons.ts keeps its own table for the transcript blocks; this one is for
   controls. Add a name here rather than pasting paths into a panel. */
const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS = {
  "refresh-cw": [
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
    "M8 16H3v5",
  ],
  folder: [
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  ],
  "file-text": [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "M10 9H8",
    "M16 13H8",
    "M16 17H8",
  ],
  "square-arrow-out-up-right": [
    "M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6",
    "m21 3-9 9",
    "M15 3h6v6",
  ],
  "volume-2": [
    "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z",
    "M16 9a5 5 0 0 1 0 6",
    "M19.364 18.364a9 9 0 0 0 0-12.728",
  ],
  "volume-x": [
    "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z",
    "m22 9-6 6",
    "m16 9 6 6",
  ],
  // lucide `copy` is a rect + a path; the rect (x8 y8 w14 h14 rx2) is written out as a
  // path so this table stays path-only
  copy: [
    "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
    "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
  ],
  "message-square-text": [
    "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
    "M7 11h10",
    "M7 15h6",
    "M7 7h8",
  ],
  // lucide `mic` is two paths + a capsule rect (x9 y2 w6 h13 rx3); since w === 2*rx the
  // "rect" is a stadium (two semicircle arcs joined by straight sides), written as one
  // path so this table stays path-only, same convention as `copy` above.
  mic: [
    "M12 19v3",
    "M19 10v2a7 7 0 0 1-14 0v-2",
    "M9 5A3 3 0 0 1 15 5V12A3 3 0 0 1 9 12Z",
  ],
  "mic-off": [
    "M12 19v3",
    "M15 9.34V5a3 3 0 0 0-5.68-1.33",
    "M16.95 16.95A7 7 0 0 1 5 12v-2",
    "M18.89 13.23A7 7 0 0 0 19 12v-2",
    "m2 2 20 20",
    "M9 9v3a3 3 0 0 0 5.12 2.12",
  ],
  pencil: [
    "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
    "m15 5 4 4",
  ],
  plus: ["M5 12h14", "M12 5v14"],
  "undo-2": [
    "M9 14 4 9l5-5",
    "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11",
  ],
  "chevron-down": ["m6 9 6 6 6-6"],
  // the file-* glyphs share the page outline and the folded corner; the extra lines follow
  "file-code": [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "M10 12.5 8 15l2 2.5",
    "m14 12.5 2 2.5-2 2.5",
  ],
  "file-type": [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "M11 18h2",
    "M12 12v6",
    "M9 13v-.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v.5",
  ],
  "file-json": [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1",
    "M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1",
  ],
  // lucide `file-cog` ends in a circle (cx7 cy18 r3), written as two arcs like `circle` above
  "file-cog": [
    "M15 8a1 1 0 0 1-1-1V2a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8z",
    "M20 8v12a2 2 0 0 1-2 2h-4.182",
    "m3.305 19.53.923-.382",
    "M4 10.592V4a2 2 0 0 1 2-2h8",
    "m4.228 16.852-.924-.383",
    "m5.852 15.228-.383-.923",
    "m5.852 20.772-.383.924",
    "m8.148 15.228.383-.923",
    "m8.53 21.696-.382-.924",
    "m9.773 16.852.922-.383",
    "m9.773 19.148.922.383",
    "M4 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  ],
  "file-terminal": [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "m8 16 2-2-2-2",
    "M12 18h4",
  ],
  // lucide `file-image` has a circle (cx10 cy12 r2), written as two arcs
  "file-image": [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "M8 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
    "m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22",
  ],
  file: [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
  ],
  // lucide `git-branch` has two circles (cx18 cy6 r3, cx6 cy18 r3), written as arcs
  "git-branch": ["M15 6a9 9 0 0 0-9 9V3", "M15 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M3 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0"],
  "arrow-up-down": ["m21 16-4 4-4-4", "M17 20V4", "m3 8 4-4 4 4", "M7 4v16"],
  "loader-circle": ["M21 12a9 9 0 1 1-6.219-8.56"],
  "eye-off": [
    "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
    "M14.084 14.158a3 3 0 0 1-4.242-4.242",
    "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
    "m2 2 20 20",
  ],
  "folder-x": [
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
    "m9.5 10.5 5 5",
    "m14.5 10.5-5 5",
  ],
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  minus: ["M5 12h14"],
  // lucide `circle` is a circle (cx12 cy12 r10), written as two arcs so this table stays path-only;
  // `circle-check` and `circle-alert` reuse it. circle-alert's two lines are written as paths.
  circle: ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0"],
  "circle-check": ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0", "m16 9-5.5 5.5L8 12"],
  "circle-alert": ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0", "M12 8v4", "M12 16h.01"],
  "circle-arrow-up": ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0", "m16 12-4-4-4 4", "M12 16V8"],
  // Jira issue-type glyphs; the rect/circle elements are written as paths, as `circle` above.
  zap: ["M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"],
  bookmark: ["M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"],
  bug: [
    "M12 20v-9",
    "M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z",
    "M14.12 3.88 16 2",
    "M21 21a4 4 0 0 0-3.81-4",
    "M21 5a4 4 0 0 1-3.55 3.97",
    "M22 13h-4",
    "M3 21a4 4 0 0 1 3.81-4",
    "M3 5a4 4 0 0 0 3.55 3.97",
    "M6 13H2",
    "m8 2 1.88 1.88",
    "M9 7.13V6a3 3 0 1 1 6 0v1.13",
  ],
  "square-check": ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "m16 9-5.5 5.5L8 12"],
  "corner-down-right": ["m15 10 5 5-5 5", "M4 4v7a4 4 0 0 0 4 4h12"],
  "circle-dot": ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0", "M13 12a1 1 0 1 0-2 0a1 1 0 1 0 2 0"],
  "arrow-left": ["m12 19-7-7 7-7", "M19 12H5"],
  // lucide `search`'s circle (cx11 cy11 r8) written as two arcs, as `circle` above.
  search: ["m21 21-4.34-4.34", "M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0"],
  "maximize-2": ["M15 3h6v6", "m21 3-7 7", "m3 21 7-7", "M9 21H3v-6"],
  // Slack places and Notion sources; rect/circle/ellipse elements written as paths, as `circle` above.
  hash: ["M4 9h16", "M4 15h16", "M10 3 8 21", "M16 3 14 21"],
  lock: ["M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z", "M7 11V7a5 5 0 0 1 10 0v4"],
  user: ["M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", "M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0"],
  users: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M16 3.128a4 4 0 0 1 0 7.744",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
  ],
  "list-checks": ["m3 17 2 2 4-4", "m3 7 2 2 4-4", "M13 6h8", "M13 12h8", "M13 18h8"],
  database: ["M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0", "M3 5V19A9 3 0 0 0 21 19V5", "M3 12A9 3 0 0 0 21 12"],
} as const;

export type LucideName = keyof typeof PATHS;

/** A 24-unit Lucide glyph sized by the `.icn` rule (or the caller's class). */
export function lucide(name: LucideName, className = "icn"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of PATHS[name]) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}
