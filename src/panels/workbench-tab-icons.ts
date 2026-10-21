// Bench tab-strip glyphs: one colour icon per header tab, named by its tab id, via
// src/icon-img.ts. `Tab` is a type-only import, erased at build and test time.

import type { Tab } from "./workbench";
import { iconImg } from "../icon-img";

export function tabIcon(kind: Tab): HTMLImageElement {
  return iconImg(kind);
}
