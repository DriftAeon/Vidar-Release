// Workbench block names: the spoken name each tray block carries (Alpha, Bravo…), the
// monotonic cursor, and the reservation set a restore holds while it is in flight.
// No imports; workbench-tray.ts passes the live blocks and its id counter in.

// Spoken names for blocks: reading a path or a hyperlink
// aloud is useless, "open Tray Delta" is not. The cursor walks the list
// monotonically and skips names a live block still holds, so a name is never
// reused while its block is on screen AND a long session stays near the front
// of the alphabet instead of reaching Quebec. Names are NOT returned on
// removal: "Tray Alpha" meaning a different block a minute later is exactly
// the confusion the naming was meant to remove (review E2).
const BLOCK_NAMES = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel",
  "India", "Juliet", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa",
  "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "Xray",
  "Yankee", "Zulu",
];
let nameCursor = 0;
/** Names claimed by a restore in flight but not yet a real block (the async
 *  window between `list_workbench_entries` and the block actually landing):
 *  a paste racing the restore must not take one of these. */
const reserved = new Set<string>();

/** Ends a name's reservation: the block landed for real, or its restore was
 *  cancelled or failed. The only way a reservation is released. */
export function releaseName(name: string): void {
  reserved.delete(name);
}

/** MAX_BLOCKS (24) < BLOCK_NAMES.length (26), so a free name always exists;
 *  the counter fallback is belt for a future cap raise, not a live path.
 *  MAX_BLOCKS lives in workbench-limits.ts; raising it past 26 needs more names here. */
export function takeBlockName(live: readonly { name: string }[], fallbackIndex: number): string {
  for (let i = 0; i < BLOCK_NAMES.length; i++) {
    const n = BLOCK_NAMES[(nameCursor + i) % BLOCK_NAMES.length];
    if (!live.some((b) => b.name === n) && !reserved.has(n)) {
      nameCursor = (nameCursor + i + 1) % BLOCK_NAMES.length;
      return n;
    }
  }
  return `Block ${fallbackIndex + 1}`;
}

/** Claims every restored name synchronously, before any restore does its
 *  first await, and walks the cursor past the highest of them so a paste
 *  right after boot lands past the alphabet's front instead of colliding. */
export function reserveNames(names: string[]): void {
  let maxIdx = -1;
  for (const n of names) {
    reserved.add(n);
    const i = BLOCK_NAMES.indexOf(n);
    if (i > maxIdx) maxIdx = i;
  }
  if (maxIdx >= 0) nameCursor = (maxIdx + 1) % BLOCK_NAMES.length;
}
