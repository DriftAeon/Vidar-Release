/* The 16px chevron tile shared by every Rendered disclosure and caret. Built with its own svg
   (not svgEl): decorative, so no role=img and no <title>. Open state is CSS-only
   (rendered-disc.css). Geometry verbatim from public/icons/lucide/chevron-right.svg (disclosure)
   and chevron-down.svg (caret), lucide v1.44.0, ISC. */
const SVG_NS = "http://www.w3.org/2000/svg";

export function chevronTile(kind: "disclosure" | "caret"): HTMLSpanElement {
  const tile = document.createElement("span");
  tile.className = kind === "caret" ? "disc disc-caret" : "disc";
  tile.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", kind === "caret" ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6");
  svg.appendChild(path);
  tile.appendChild(svg);
  return tile;
}
