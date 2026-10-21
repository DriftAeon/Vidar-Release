// Catalog group → colour icon for the Document Open menu folders; `iconSlot` also fills the
// settings modal's icon slots.

import { iconImg, type ColorIcon } from "../icon-img";

const DOCS_ICONS: Record<string, ColorIcon> = {
  explore: "grp-explore", projects: "grp-projects", reference: "grp-reference", shelf: "grp-shelf",
};

/** Group icon: no group = a bridge\display file, "Display" = Document's group of those files,
 *  "Docs · <folder>" matched case-insensitively; unknown = none. */
export function groupIcon(group: string | undefined): ColorIcon | null {
  if (!group) return "display";
  const g = group.toLowerCase();
  if (g === "display") return "display";
  if (g === "inbox") return "grp-inbox";
  if (g === "reviews") return "grp-findings";
  if (g === "runs" || g.startsWith("run · ")) return "grp-run";
  if (g.startsWith("docs · ")) return DOCS_ICONS[g.slice("docs · ".length).trim()] ?? null;
  return null;
}

/** Fixed-width slot left of the name; empty (alignment only) when there is no icon. */
export function iconSlot(name: ColorIcon | null): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "gi";
  if (name) s.appendChild(iconImg(name));
  return s;
}
