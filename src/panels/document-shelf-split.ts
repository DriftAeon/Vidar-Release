// Pure helper for the Open menu's Shelf folder: bottom-shelf files list after the top-level
// shelf files, under a divider. No imports, so node --test can load it.

/** folder key of docs\shelf in the Open menu */
export const SHELF_KEY = "Docs · shelf";
const BOTTOM_DIR = "bottom-shelf";

function parentDir(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

/** True when the entry sits directly in a bottom-shelf folder. */
export function isBottomShelf(e: { path: string }): boolean {
  return parentDir(e.path) === BOTTOM_DIR;
}

/** Splits already-sorted Shelf entries into top-level and bottom-shelf, each keeping its order. */
export function splitShelf<T extends { path: string }>(entries: T[]): { top: T[]; bottom: T[] } {
  const top: T[] = [];
  const bottom: T[] = [];
  for (const e of entries) (isBottomShelf(e) ? bottom : top).push(e);
  return { top, bottom };
}
