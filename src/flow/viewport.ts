// Owns pan/zoom transform, fit-to-view, the zoom toast and the RAF redraw
// loop. Must not touch selection, edges or node data beyond S.nodes/nodeEls
// for measuring bounding boxes.

import { S, SCALE_MIN, SCALE_STOPS } from "./state";
import { createToast } from "../toast";
import { flowStorage } from "./file-storage";
import { createViewportMemory } from "./viewport-memory";

/** Next stop strictly past `scale` in the wheel's direction; an off-grid scale snaps to its neighbour. */
function stepStop(scale: number, zoomIn: boolean): number {
  const eps = 1e-6;
  if (zoomIn) return SCALE_STOPS.find((s) => s > scale + eps) ?? scale;
  return [...SCALE_STOPS].reverse().find((s) => s < scale - eps) ?? scale;
}

/** Largest stop that is at most `ratio`, so a fit never crops. */
function floorStop(ratio: number): number {
  return [...SCALE_STOPS].reverse().find((s) => s <= ratio + 1e-6) ?? SCALE_MIN;
}

export function beginPan(e: PointerEvent) {
  S.canvasEl.setPointerCapture(e.pointerId);
  S.dragging = { kind: "pan", startX: e.clientX, startY: e.clientY, panX: S.panX, panY: S.panY };
  scheduleFrame();
}

/** Move-time body for an in-flight pan, dispatched from panels/flow.ts's
 *  onPointerMove by drag kind. */
export function onPanMove(d: import("./state").PanDrag, e: PointerEvent) {
  S.panX = d.panX + (e.clientX - d.startX);
  S.panY = d.panY + (e.clientY - d.startY);
  applyWorldTransform();
  S.edgesDirty = true;
}

export function visible(): boolean {
  return S.rootEl.offsetParent !== null;
}

const memory = createViewportMemory(flowStorage);

/** Applies the open graph's saved pan/zoom; `false` when it has none (unsaved draft included). */
export function restoreViewport(): boolean {
  const id = S.activeGraphId;
  const vp = id ? memory.get(id) : null;
  if (!vp) return false;
  S.panX = vp.panX;
  S.panY = vp.panY;
  S.scale = vp.scale;
  applyWorldTransform();
  return true;
}

/** A deleted graph's view goes with it. */
export function forgetViewport(id: string): void {
  memory.forget(id);
}

export function applyWorldTransform() {
  S.worldEl.style.transform = `translate(${S.panX}px, ${S.panY}px) scale(${S.scale})`;
  // Only stored graphs are remembered; an unsaved template draft has no stable id to key by.
  const id = S.activeGraphId;
  if (id && S.graphs.some((g) => g.id === id)) memory.set(id, { panX: S.panX, panY: S.panY, scale: S.scale });
  // Wheel zoom and fit-to-view are single events, not a drag,
  // so without this the popover's repositionPopover (riding the same frame loop redrawEdges uses)
  // never ran after either — the card sat still while the graph zoomed/reframed under it.
  scheduleFrame();
}

/** Zoom about the cursor: the world point under it stays put. The canvas
 *  swallows every wheel event (Ctrl+wheel included) so WebView2's page zoom
 *  never fires while the pointer is over the graph. */
export function onWheel(e: WheelEvent) {
  e.preventDefault();
  if (S.dragging) return;
  const next = stepStop(S.scale, e.deltaY < 0);
  if (next === S.scale) return;
  const rect = S.canvasEl.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  S.panX = cx - ((cx - S.panX) / S.scale) * next;
  S.panY = cy - ((cy - S.panY) / S.scale) * next;
  S.scale = next;
  applyWorldTransform();
  showFlowZoomToast();
}

/** Frames every node: scale to fit (min of width-fit/height-fit, clamped),
 *  pan so the bounding box centres in the canvas. No-op with an empty graph. */
export function fitToView(quiet = false) {
  if (!S.nodes.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of S.nodes) {
    const el = S.nodeEls.get(n.id);
    if (!el) continue;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + el.offsetWidth);
    maxY = Math.max(maxY, n.y + el.offsetHeight);
  }
  if (!Number.isFinite(minX)) return;
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const canvasW = S.canvasEl.offsetWidth;
  const canvasH = S.canvasEl.offsetHeight;
  const next = floorStop(Math.min(canvasW / (bboxW + 80), canvasH / (bboxH + 80)));
  S.scale = next;
  S.panX = canvasW / 2 - ((minX + maxX) / 2) * S.scale;
  S.panY = canvasH / 2 - ((minY + maxY) / 2) * S.scale;
  applyWorldTransform();
  if (!quiet) showFlowZoomToast();
}

// An element inside .flow-canvas (not body) so it belongs to the Flow tab and positions
// relative to the graph, not the window. The one Flow toast surface — zoom and a failed-save
// note (store.ts/runs-store.ts's onSaveFailed, wired in panels/flow.ts) share it.
const flowToast = createToast({ id: "flow-zoom-toast", host: () => S.canvasEl });
export function showFlowToast(message: string, ms = 500) {
  flowToast(message, ms);
}

function showFlowZoomToast() {
  showFlowToast(`Zoom ${Math.round(S.scale * 100)}%`);
}

/** `tick` needs to trigger an edge redraw, which lives in a later module
 *  (edges.ts) — the one permitted inversion: the redraw callback is injected
 *  once at mount time instead of viewport.ts importing edges.ts. */
let redrawEdges: (() => void) | null = null;

export function initFrameLoop(redraw: () => void) {
  redrawEdges = redraw;
}

export function scheduleFrame() {
  S.edgesDirty = true;
  if (S.rafActive) return;
  S.rafActive = true;
  requestAnimationFrame(tick);
}

function tick() {
  S.rafActive = false;
  if (!visible()) return;
  if (S.edgesDirty) {
    S.edgesDirty = false;
    redrawEdges?.();
  }
  if (S.dragging) scheduleFrame();
}
