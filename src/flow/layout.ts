// Tidy's layout: pure, no DOM, no value imports (a leaf, so node --test can load it).
// tidy.ts measures the cards and
// animates to the result.

export type LayoutNode = { id: string; w: number; h: number };
export type LayoutEdge = { from: string; to: string };
export type LayoutOpts = {
  /** centre line of the spine (default 0) */
  axisX?: number;
  /** y of row 0 (default 48) */
  top?: number;
  /** snap (default 16) */
  grid?: number;
  /** min gap between cards in a row (default 48) */
  gapX?: number;
  /** gap between rows, measured from the tallest card in the row (default 48) */
  gapY?: number;
};

/**
 * Returns each node's card top-left (world px), top-to-bottom.
 *   nodes  in document order (order breaks ties: first sibling goes left).
 *   edges  out -> in. Self-loops and edges to unknown ids are ignored.
 *
 * 1. Layer = longest path from a source (Input lands in row 0). An edge into a node on the
 *    current DFS stack closes a cycle and is ignored for layering.
 * 2. Row y = previous row y + tallest card in that row + gapY, rounded up to the grid.
 * 3. Row by row, each node wants the mean centre of its parents (sources want axisX). Siblings
 *    with the same parent set spread symmetrically around that centre at a pitch of card width
 *    + gapX rounded up to 2 grids, so the half-pitch stays on the grid.
 * 4. Overlaps are pushed apart left to right, then the row is shifted back so its mean centre is
 *    where it wanted to be. Lefts snap to the grid; a child with one parent (or parents placed
 *    symmetrically) gets exactly the parent's centre, so its edge is a straight line.
 */
export function autoLayout(nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOpts = {}): Record<string, { x: number; y: number }> {
  const grid = opts.grid ?? 16;
  const gapX = opts.gapX ?? 48;
  const gapY = opts.gapY ?? 48;
  const top = opts.top ?? 48;
  const axis = opts.axisX ?? 0;
  const out: Record<string, { x: number; y: number }> = {};
  if (!nodes.length) return out;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parents = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (e.from !== e.to && byId.has(e.from) && byId.has(e.to)) parents.get(e.to)!.push(e.from);
  }

  // 1. layers
  const layer = new Map<string, number>();
  const onStack = new Set<string>();
  const depth = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    onStack.add(id);
    let d = 0;
    for (const p of parents.get(id)!) if (!onStack.has(p)) d = Math.max(d, depth(p) + 1);
    onStack.delete(id);
    layer.set(id, d);
    return d;
  };
  nodes.forEach((n) => depth(n.id));
  const sparse: LayoutNode[][] = [];
  for (const n of nodes) (sparse[layer.get(n.id)!] ??= []).push(n);
  const rows = sparse.filter(Boolean);

  // 2. row tops
  const snapUp = (v: number) => Math.ceil(v / grid) * grid;
  const rowY: number[] = [];
  let y = top;
  for (const row of rows) {
    const ry = snapUp(y);
    rowY.push(ry);
    y = ry + Math.max(...row.map((n) => n.h)) + gapY;
  }

  // 3-4. centres, row by row
  const maxW = Math.max(...nodes.map((n) => n.w));
  const pitch = Math.ceil((maxW + gapX) / (2 * grid)) * 2 * grid;
  const centre = new Map<string, number>();
  rows.forEach((row, r) => {
    const groups = new Map<string, { want: number; ids: LayoutNode[] }>();
    for (const n of row) {
      const ps = parents.get(n.id)!.filter((p) => centre.has(p));
      const key = [...ps].sort().join("|");
      const want = ps.length ? ps.reduce((s, p) => s + centre.get(p)!, 0) / ps.length : axis;
      if (!groups.has(key)) groups.set(key, { want, ids: [] });
      groups.get(key)!.ids.push(n);
    }
    const slots: { n: LayoutNode; x: number; target: number }[] = [];
    for (const g of [...groups.values()].sort((a, b) => a.want - b.want)) {
      const k = g.ids.length;
      g.ids.forEach((n, i) => {
        const x = g.want + (i - (k - 1) / 2) * pitch;
        slots.push({ n, x, target: x });
      });
    }
    for (let i = 1; i < slots.length; i++) {
      if (slots[i].x < slots[i - 1].x + pitch) slots[i].x = slots[i - 1].x + pitch;
    }
    const mean = (f: (s: (typeof slots)[number]) => number) => slots.reduce((s, v) => s + f(v), 0) / slots.length;
    const shift = mean((s) => s.target) - mean((s) => s.x);
    for (const s of slots) {
      const left = Math.round((s.x + shift - s.n.w / 2) / grid) * grid;
      centre.set(s.n.id, left + s.n.w / 2);
      out[s.n.id] = { x: left, y: rowY[r] };
    }
  });
  return out;
}
