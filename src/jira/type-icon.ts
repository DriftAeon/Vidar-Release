// Renders a Jira issue-type icon: a colour image or a Lucide glyph, both in the `.icn` box.
import { lucide } from "../icons";
import { iconImg } from "../icon-img";
import type { TypeIcon } from "./model";

export function renderTypeIcon(t: TypeIcon): Element {
  return "color" in t ? iconImg(t.color) : lucide(t.lucide);
}
