// Snapping: pure grid-round and
// port-magnet math. Leaf module — no imports beyond `import type` (erased), so
// tests/flow-snap.test.mjs can import it directly under `node --test` (leaf-module
// rule: Node ESM cannot resolve nodes.ts's extensionless value imports).

/** Rounds a single coordinate to the nearest multiple of `grid`. */
export function snapCoord(v: number, grid: number): number {
  return Math.round(v / grid) * grid;
}

/** Rounds both axes of a drag position to the nearest grid point — used by
 *  nodes.ts's onNodeDragMove so a dragged node's on-screen position always
 *  lands on a `grid`-px increment, continuously during the drag (§5). */
export function snapPoint(x: number, y: number, grid: number): { x: number; y: number } {
  return { x: snapCoord(x, grid), y: snapCoord(y, grid) };
}

/** An axis-aligned box in the same shape `DOMRect` already gives edges.ts
 *  (`left`/`right`/`top`/`bottom`) — kept as a plain interface, not `DOMRect`
 *  itself, so this module never touches the DOM and stays a leaf. */
export interface SlackRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** model.ts's node-id charset (§2, restated here per the leaf-module rule —
 *  a leaf can't import a value regex from a wiring-adjacent module, only
 *  `import type`): `/^[a-z][a-z0-9_-]*$/`. */
const ID_CHARSET = /^[a-z][a-z0-9_-]*$/;

/** True when `id` matches model.ts's id charset (§2). */
export function isValidId(id: string): boolean {
  return ID_CHARSET.test(id);
}

/** Mints a node id unique within `used`, matching the id charset above:
 *  `<base>-<n>`, `base` lowercased and reduced to that charset, `n` starting
 *  at 1 and incrementing past any collision — except `base === "input"`,
 *  which mints bare `"input"` when free (§2 freezes the input node's id as
 *  `"input"` so `{{input}}` and the input node coincide, §4.2); a caller
 *  that already has an `input` node falls through to the numbered form like
 *  any other base, rather than colliding silently. */
export function mintId(base: string, used: ReadonlySet<string>): string {
  const cleanBase = base.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z]+/, "") || "node";
  if (cleanBase === "input" && !used.has("input")) return "input";
  let n = 1;
  let id = `${cleanBase}-${n}`;
  while (used.has(id)) {
    n += 1;
    id = `${cleanBase}-${n}`;
  }
  return id;
}

/** True when (x, y) falls inside `rect` expanded by `slack` on every side —
 *  the exact rect-compare shape edges.ts's findDropTarget already used at
 *  SLACK=10 (§7 "corrected from the v1 plan's pixel-exact framing"); the v2
 *  change widens the caller's slack to ~20 and reuses this same test for the
 *  port-approach highlight, not just the drop hit-test. */
export function withinSlack(x: number, y: number, rect: SlackRect, slack: number): boolean {
  return x >= rect.left - slack && x <= rect.right + slack && y >= rect.top - slack && y <= rect.bottom + slack;
}
