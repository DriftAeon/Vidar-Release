// Lab tab: the delta-per-commit series from `lab_item` runs, no DOM (tests import it).
// X is the rune's commit (itemCommit) in history order of first appearance, never the date. Every run
// with a delta is a point; only comparable runs (not partial, not dry, isolation ok, and the row's own
// `comparable`) join the line, one vertex per commit at the mean of its comparable deltas.
import type { LabRun } from "./types";

export interface ChartPoint {
  /** Index into `LabSeries.commits`. */
  x: number;
  delta: number;
  comparable: boolean;
  runId: string;
}

export interface LabSeries {
  /** Item commits in history order of first appearance; `null` is a run with no recorded commit. */
  commits: (string | null)[];
  points: ChartPoint[];
  /** The comparable line, ascending x. */
  line: { x: number; delta: number }[];
}

export const isComparable = (r: LabRun): boolean =>
  r.comparable && !r.partial && !r.dry && r.isolation === "ok" && r.scores.delta !== null;

export function buildSeries(runs: LabRun[]): LabSeries {
  const commits: (string | null)[] = [];
  const index = new Map<string | null, number>();
  const points: ChartPoint[] = [];
  for (const r of runs) {
    let x = index.get(r.itemCommit);
    if (x === undefined) {
      x = commits.length;
      index.set(r.itemCommit, x);
      commits.push(r.itemCommit);
    }
    if (r.scores.delta === null) continue;
    points.push({ x, delta: r.scores.delta, comparable: isComparable(r), runId: r.runId });
  }
  const sums = new Map<number, { sum: number; n: number }>();
  for (const p of points) {
    if (!p.comparable) continue;
    const s = sums.get(p.x) ?? { sum: 0, n: 0 };
    s.sum += p.delta;
    s.n += 1;
    sums.set(p.x, s);
  }
  const line = [...sums].sort((a, b) => a[0] - b[0]).map(([x, s]) => ({ x, delta: s.sum / s.n }));
  return { commits, points, line };
}

export interface ChartBox {
  width: number;
  height: number;
  pad: number;
}

/** Plot coordinates: x spread evenly across the commits, delta on a fixed -1..1 scale (scores are 0..1). */
export function project(series: LabSeries, box: ChartBox): { px: (x: number) => number; py: (d: number) => number } {
  const n = series.commits.length;
  const w = box.width - 2 * box.pad;
  const h = box.height - 2 * box.pad;
  const px = (x: number) => box.pad + (n <= 1 ? w / 2 : (x * w) / (n - 1));
  const py = (d: number) => box.pad + ((1 - Math.max(-1, Math.min(1, d))) * h) / 2;
  return { px, py };
}

/** SVG path `d` for the comparable line; empty when fewer than two vertices. */
export function linePath(series: LabSeries, box: ChartBox): string {
  if (series.line.length < 2) return "";
  const { px, py } = project(series, box);
  return series.line.map((v, i) => `${i ? "L" : "M"}${px(v.x).toFixed(1)} ${py(v.delta).toFixed(1)}`).join(" ");
}

export const shortCommit = (c: string | null): string => (c ? c.slice(0, 7) : "—");
