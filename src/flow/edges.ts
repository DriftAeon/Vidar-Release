// Edge geometry, rendering, selection and creation-by-drag. Must not import
// selection.ts or inspector.ts (later modules) — selection/inspector refresh
// goes through the injected onSelectionChanged callback instead.

import type { FlowEdge } from "./model";
import { S, SVG_NS, canvasPoint } from "./state";
import { scheduleFrame } from "./viewport";
import { scheduleGraphSave } from "./store";
import { withinSlack } from "./snap";
import { routeOrthogonal, pathD, type Box, type Pt } from "./route";

/** Magnetic radius around a port, in screen px, for both the drop hit-test
 *  and the approach highlight (magnetic port preview):
 *  widened from the original 10px pixel-exact hit-test to ~20px. */
const SLACK = 20;

/** The port element currently highlighted by an in-flight edge drag, if any —
 *  module-local since only one edge drag (S.dragging) can be live at a time. */
let highlightedPortEl: HTMLElement | null = null;

function setPortHighlight(el: HTMLElement | null) {
  if (highlightedPortEl === el) return;
  highlightedPortEl?.classList.remove("flow-snap-port-near");
  highlightedPortEl = el;
  highlightedPortEl?.classList.add("flow-snap-port-near");
}

/** Clears any in-progress port highlight without touching S.dragging —
 *  loadGraph calls this on reload (a highlighted port would otherwise
 *  reference a detached element); a pointercancel path (cancelDrag, owned by
 *  panels/flow.ts) should call it too, left as a note for that
 *  module rather than reached into here. */
export function clearPortHighlight() {
  setPortHighlight(null);
}

/** selection.ts registers itself here at module load so edges.ts never has
 *  to import forward into selection.ts/inspector.ts — the same inversion
 *  pattern viewport.ts uses for the frame loop's redraw callback. */
let selectionChangedCb: (() => void) | null = null;

export function onSelectionChanged(cb: () => void) {
  selectionChangedCb = cb;
}

function notifySelectionChanged() {
  selectionChangedCb?.();
}

/** Height of the port triangle in px — must match `.flow-port svg`'s height in styles.css. */
const PORT_H = 5;

/** Where an edge meets a port, in world px: the out triangle's apex, or the in triangle's base
 *  centre. The single source for the x is the port element's own box (the triangle is centred in
 *  it by CSS), read with layout offsets — not NODE_W/2 — so the line and the triangle can't drift
 *  apart. `clientLeft/Top` add the card's border, since a child's offsetLeft/Top is measured from
 *  the card's padding edge. Offsets ignore the hover `transform`, which is what we want. */
function portCenter(id: string, side: "in" | "out"): Pt {
  const el = S.nodeEls.get(id);
  if (!el) return { x: 0, y: 0 };
  const port = el.querySelector<HTMLElement>(side === "in" ? ".flow-port-in" : ".flow-port-out");
  if (!port) {
    const y = side === "in" ? el.offsetTop : el.offsetTop + el.offsetHeight;
    return { x: el.offsetLeft + el.offsetWidth / 2, y };
  }
  const x = el.offsetLeft + el.clientLeft + port.offsetLeft + port.offsetWidth / 2;
  const base = el.offsetTop + el.clientTop + port.offsetTop;
  return { x, y: side === "in" ? base : base + PORT_H };
}

function nodeBox(id: string): Box | undefined {
  const el = S.nodeEls.get(id);
  if (!el) return undefined;
  return { l: el.offsetLeft, t: el.offsetTop, r: el.offsetLeft + el.offsetWidth, b: el.offsetTop + el.offsetHeight };
}

/** Orthogonal `d` from `from`'s out port to `to` — another node's in port, or (edge-drag draft)
 *  a bare point with no box. */
function edgeD(from: string, to: Pt, toBox?: Box): string {
  const src = portCenter(from, "out");
  return pathD(routeOrthogonal(src, "bottom", to, "top", { srcBox: nodeBox(from), dstBox: toBox }));
}

/** Builds an edge's visible path plus its invisible wider hit-target twin,
 *  wired the same way for both mount-time edges and ones created by dragging
 *  from a port. Neither has a `d` yet — the caller (or the next redraw)
 *  positions them. */
export function buildEdgePath(edge: FlowEdge): import("./state").EdgePathPair {
  const sourceKind = S.nodes.find((n) => n.id === edge.from.node)?.kind ?? "agent";
  const vis = document.createElementNS(SVG_NS, "path") as SVGPathElement;
  vis.setAttribute("class", `flow-edge flow-edge-${sourceKind}`);
  const hit = document.createElementNS(SVG_NS, "path") as SVGPathElement;
  hit.setAttribute("class", "flow-edge-hit");
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    selectEdge(edge.id);
  };
  const onDown = (e: PointerEvent) => {
    if (e.button === 0) e.stopPropagation();
  };
  vis.addEventListener("pointerdown", onDown);
  vis.addEventListener("click", onClick);
  hit.addEventListener("pointerdown", onDown);
  hit.addEventListener("click", onClick);
  return { vis, hit };
}

/** The single place edges re-render (the frame loop's redraw callback), so it also owns the
 *  in-port fill: `.connected` on a node's `.flow-port-in` while any edge lands on it. Every edge
 *  change (drop, delete, node delete, graph load/switch/reset) ends in scheduleFrame, so the
 *  class follows the edges without each path toggling it. */
export function redrawEdges() {
  const targets = new Set<string>();
  for (const e of S.edges) {
    targets.add(e.to.node);
    const pair = S.edgePaths.get(e.id);
    if (!pair) continue;
    const d = edgeD(e.from.node, portCenter(e.to.node, "in"), nodeBox(e.to.node));
    pair.vis.setAttribute("d", d);
    pair.hit.setAttribute("d", d);
  }
  for (const [id, el] of S.nodeEls) {
    el.querySelector(".flow-port-in")?.classList.toggle("connected", targets.has(id));
  }
}

function selectEdge(id: string) {
  S.selected = new Set();
  S.selectedEdge = id;
  notifySelectionChanged();
}

export function deleteSelectedEdge() {
  if (!S.selectedEdge) return;
  const id = S.selectedEdge;
  S.edges = S.edges.filter((e) => e.id !== id);
  const pair = S.edgePaths.get(id);
  pair?.vis.remove();
  pair?.hit.remove();
  S.edgePaths.delete(id);
  S.selectedEdge = null;
  notifySelectionChanged();
  scheduleFrame(); // the target's in port goes hollow (redrawEdges owns `.connected`)
  scheduleGraphSave();
}

export function beginEdgeDrag(e: PointerEvent, sourceId: string) {
  S.canvasEl.setPointerCapture(e.pointerId);
  const draft = document.createElementNS(SVG_NS, "path") as SVGPathElement;
  draft.setAttribute("class", "flow-edge-draft");
  S.edgesEl.appendChild(draft);
  S.dragging = { kind: "edge", from: sourceId, draft };
  scheduleFrame();
}

/** Shared rect scan behind findDropTarget and updatePortHighlight (the two
 *  would otherwise duplicate this loop verbatim). Skips
 *  `excludeId` (an edge can't target its own source) and, when `skipIfEdge`
 *  is set, any node that already has an edge from that source — such a drop
 *  would be a no-op (finishEdgeDrag's own `exists` check below), so lighting
 *  that port during the drag is misleading. Returns the matching node id and
 *  its in-port element, or null when nothing is within SLACK. */
function portInRange(e: PointerEvent, excludeId: string, skipIfEdge: boolean): { id: string; port: HTMLElement } | null {
  for (const n of S.nodes) {
    if (n.id === excludeId) continue;
    if (skipIfEdge && S.edges.some((edge) => edge.from.node === excludeId && edge.to.node === n.id)) continue;
    const el = S.nodeEls.get(n.id);
    const port = el?.querySelector<HTMLElement>(".flow-port-in");
    if (!port) continue;
    const r = port.getBoundingClientRect();
    if (withinSlack(e.clientX, e.clientY, r, SLACK)) return { id: n.id, port };
  }
  return null;
}

/** Rect-compare hit test (chosen over an elementFromPoint walk — the ports
 *  are small absolutely-positioned spans, so comparing the cursor against
 *  each candidate's own getBoundingClientRect, padded by a slack, is direct
 *  and doesn't depend on what's stacked on top at that screen point). */
function findDropTarget(e: PointerEvent, excludeId: string): string | null {
  return portInRange(e, excludeId, false)?.id ?? null;
}

/** Same rect scan as findDropTarget, run on every edge-drag move to light up
 *  the in-port the cursor is within SLACK of, before drop.
 *  Returns the highlighted port element, or null when nothing is in range. */
function updatePortHighlight(e: PointerEvent, excludeId: string): HTMLElement | null {
  const hit = portInRange(e, excludeId, true);
  setPortHighlight(hit?.port ?? null);
  return hit?.port ?? null;
}

/** Move-time body for an in-flight edge drag, dispatched from
 *  panels/flow.ts's onPointerMove by drag kind. */
export function onEdgeDragMove(d: import("./state").EdgeDrag, e: PointerEvent) {
  const p = canvasPoint(e);
  const wx = (p.x - S.panX) / S.scale;
  const wy = (p.y - S.panY) / S.scale;
  d.draft.setAttribute("d", edgeD(d.from, { x: wx, y: wy }));
  updatePortHighlight(e, d.from);
}

export function finishEdgeDrag(d: import("./state").EdgeDrag, e: PointerEvent) {
  d.draft.remove();
  setPortHighlight(null);
  const targetId = findDropTarget(e, d.from);
  if (!targetId) return;
  const exists = S.edges.some((edge) => edge.from.node === d.from && edge.to.node === targetId);
  if (exists) return;
  // A chain never branches or merges (validate.ts), so the new arrow replaces any arrow already
  // leaving its source or entering its target: dropping a node between Input and Output used to
  // leave Input → Output in place and the graph invalid with Run disabled.
  const displaced = S.edges.filter((edge) => edge.from.node === d.from || edge.to.node === targetId);
  if (displaced.length) {
    const gone = new Set(displaced.map((edge) => edge.id));
    S.edges = S.edges.filter((edge) => !gone.has(edge.id));
    for (const id of gone) {
      const old = S.edgePaths.get(id);
      old?.vis.remove();
      old?.hit.remove();
      S.edgePaths.delete(id);
    }
    if (S.selectedEdge && gone.has(S.selectedEdge)) {
      S.selectedEdge = null;
      notifySelectionChanged();
    }
  }
  const edge: FlowEdge = { id: "e" + Date.now(), from: { node: d.from, port: "out" }, to: { node: targetId, port: "in" } };
  S.edges.push(edge);
  const pair = buildEdgePath(edge);
  S.edgePaths.set(edge.id, pair);
  S.edgesEl.appendChild(pair.hit);
  S.edgesEl.appendChild(pair.vis);
  scheduleFrame();
  scheduleGraphSave();
}

/** Accessor for an edge's rendered path pair by edge id — the seam
 *  run-view.ts uses to paint status classes onto edges, the
 *  same way S.nodeEls does for nodes. Reads S.edgePaths rather than exposing
 *  the map itself, so edges.ts stays the map's single writer. */
export function edgeEls(id: string): import("./state").EdgePathPair | undefined {
  return S.edgePaths.get(id);
}
