// Orthogonal edge routing: pure geometry, no DOM, no value imports (a leaf, so node --test can
// load it). Corners are sharp;
// edges.ts feeds it port points and card boxes and writes the resulting `d`.

export type Pt = { x: number; y: number };
/** Card rect in world px. */
export type Box = { l: number; t: number; r: number; b: number };
export type PortSide = "top" | "bottom";

/**
 * Routes from the out port's apex `src` to the in port's base centre `dst` (world px).
 * Vidar's ports are out = "bottom", in = "top", the only pair implemented; any other pair throws
 * so a future side change is loud. `srcBox`/`dstBox` let a backward edge go around both cards;
 * `stub` is the leg length out of/into a port (default 16 = S.GRID), `clear` the outer-lane
 * distance from the cards (default 24).
 *
 * Returns a simplified polyline (no duplicate or collinear points), first = src, last = dst,
 * the last segment always vertical-down into the in port so the in-port triangle reads as the
 * arrowhead (no marker).
 */
export function routeOrthogonal(
  src: Pt,
  srcSide: PortSide,
  dst: Pt,
  dstSide: PortSide,
  opts: { srcBox?: Box; dstBox?: Box; stub?: number; clear?: number } = {},
): Pt[] {
  if (srcSide !== "bottom" || dstSide !== "top") throw new Error(`routeOrthogonal: ${srcSide}->${dstSide} not implemented`);
  const stub = opts.stub ?? 16;
  const clear = opts.clear ?? 24;
  const pt = (x: number, y: number): Pt => ({ x, y });

  // Forward: the target port is below the source port with room for a jog. One horizontal run
  // at the mid-height between them (a straight line when the ports line up).
  if (dst.y - src.y >= stub) {
    const midY = Math.round((src.y + dst.y) / 2);
    return simplify([src, pt(src.x, midY), pt(dst.x, midY), dst]);
  }

  // Backward: leave the source downward by a stub, run sideways to a vertical lane that clears
  // both cards, climb to a stub above the target, run across, drop into the port.
  const A = opts.srcBox ?? { l: src.x, r: src.x, t: src.y, b: src.y };
  const B = opts.dstBox ?? { l: dst.x, r: dst.x, t: dst.y, b: dst.y };
  let laneX: number;
  if (A.l - B.r >= stub) laneX = Math.round((A.l + B.r) / 2); // gap: target is left
  else if (B.l - A.r >= stub) laneX = Math.round((A.r + B.l) / 2); // gap: target is right
  else {
    // cards overlap in x: go outside both
    const left = Math.min(A.l, B.l) - clear;
    const right = Math.max(A.r, B.r) + clear;
    const cost = (x: number) => Math.abs(src.x - x) + Math.abs(dst.x - x);
    laneX = cost(left) <= cost(right) ? left : right;
  }
  const lowY = src.y + stub;
  const highY = dst.y - stub;
  return simplify([src, pt(src.x, lowY), pt(laneX, lowY), pt(laneX, highY), pt(dst.x, highY), dst]);
}

/** Drops repeated points and middle points of straight runs. */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      if ((a.x === last.x && last.x === p.x) || (a.y === last.y && last.y === p.y)) out.pop();
    }
    out.push(p);
  }
  return out;
}

/** Polyline -> SVG path `d`, sharp corners. */
export function pathD(pts: Pt[]): string {
  return pts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
}
