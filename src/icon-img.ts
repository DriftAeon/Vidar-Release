// Colour icon images: one <img class="icn"> per file in public/icons/color/<name>.<svg|png>.
// The files are copies checked into the repo (never a link to the icon
// library on disk). The list of names is contracts/icons.json, written by tools/icons/slot.mjs;
// provenance per file is in public/icons/color/PROVENANCE.md (generated from it).
// Colour art is not tinted by currentColor, so buttons keep their own hover/active look
// and the art stays as drawn.

import manifest from "../contracts/icons.json" with { type: "json" };

export type ColorIcon = keyof typeof manifest.icons;

/** Icons whose source is a PNG; everything else is `<name>.svg`. */
const PNG_ICONS: ReadonlySet<string> = new Set(
  Object.entries(manifest.icons)
    .filter(([, icon]) => icon.source.toLowerCase().endsWith(".png"))
    .map(([name]) => name),
);

/** Tool name → icon and proxy backend name → icon, from the manifest. The one cast lives here:
 *  tests/icon-manifest.test.mjs asserts every value is an `icons` key. */
export const TOOL_ICON_MAP = new Map(Object.entries(manifest.tools)) as ReadonlyMap<string, ColorIcon>;
// `backends` is also the lookup for MCP server names (rack rows, `mcp__<server>__...` pills): "proxy" is a server, not a backend.
// A value is one icon name or a list (vidar-drive: app mark then steer); BACKEND_ICONS_MAP keeps the list, BACKEND_ICON_MAP the first.
export const BACKEND_ICONS_MAP = new Map(
  Object.entries(manifest.backends as Record<string, string | string[]>).map(([k, v]) => [k, [v].flat()]),
) as ReadonlyMap<string, readonly ColorIcon[]>;
export const BACKEND_ICON_MAP = new Map([...BACKEND_ICONS_MAP].map(([k, v]) => [k, v[0]])) as ReadonlyMap<string, ColorIcon>;

/** Icons drawn as one flat grey (dark mode): `.icn-grey` is `filter: grayscale(1)` in rendered.css. */
const GREY_ICONS: ReadonlySet<ColorIcon> = new Set<ColorIcon>(["mic", "person", "people-community"]);

export function iconImg(name: ColorIcon): HTMLImageElement {
  const img = document.createElement("img");
  img.className = GREY_ICONS.has(name) ? "icn icn-grey" : "icn";
  img.src = `/icons/color/${name}.${PNG_ICONS.has(name) ? "png" : "svg"}`;
  img.alt = "";
  img.draggable = false;
  img.setAttribute("aria-hidden", "true");
  return img;
}
