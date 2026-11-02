// Placement for a node dropped from the "+" palette: pure, no DOM. Every drop lands at the visible
// canvas centre, so two drops at one pan/zoom would stack; `freeSpot` walks the drop point down
// and right until the new card clears every existing one.

import { snapCoord } from "./snap";
import { NODE_W } from "./state";

/** Nominal card height. No exported height constant exists (nodes size to their content, and
 *  control-core's tidy estimate is private), so this is the tallest ordinary card face: an agent
 *  card with its task rows. */
export const NODE_H_NOMINAL = 96;
/** Extra clearance on every side so the ports on a card's edges stay grabbable. */
export const PORT_MARGIN = 16;
/** Search steps are this many grid cells right and down. */
const STEP_CELLS = 2;
/** Iteration cap; past it the last candidate is used rather than looping forever. */
const MAX_STEPS = 200;

interface Origin {
  x: number;
  y: number;
}

/** True when a card at `a` overlaps (port margin included) a card at `b`. */
function overlaps(a: Origin, b: Origin): boolean {
  return (
    a.x < b.x + NODE_W + PORT_MARGIN &&
    b.x < a.x + NODE_W + PORT_MARGIN &&
    a.y < b.y + NODE_H_NOMINAL + PORT_MARGIN &&
    b.y < a.y + NODE_H_NOMINAL + PORT_MARGIN
  );
}

/** Grid-snapped origin at or after `at` whose card clears every node in `nodes`. */
export function freeSpot(at: Origin, nodes: readonly Origin[], grid: number): Origin {
  let x = snapCoord(at.x, grid);
  let y = snapCoord(at.y, grid);
  for (let i = 0; i < MAX_STEPS && nodes.some((n) => overlaps({ x, y }, n)); i++) {
    x += STEP_CELLS * grid;
    y += STEP_CELLS * grid;
  }
  return { x, y };
}
