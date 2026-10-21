// Node/edge selection state changes, selection-class refresh, and the
// shift-drag marquee. Registers with edges.onSelectionChanged so edge
// selection (owned by edges.ts) can drive this file's refresh without
// edges.ts importing forward into it.

import { S, canvasPoint } from "./state";
import { onSelectionChanged as onEdgeSelectionChanged } from "./edges";

/** popover.ts registers renderPopover here at load — the same inversion
 *  edges.ts uses for viewport's frame loop, one hop further down the chain. */
let inspectorCb: (() => void) | null = null;

export function onSelectionChanged(cb: () => void) {
  inspectorCb = cb;
}

function notifyInspector() {
  inspectorCb?.();
}

function applySelectionClasses() {
  for (const [nid, el] of S.nodeEls) el.classList.toggle("selected", S.selected.has(nid));
  for (const e of S.edges) {
    const pair = S.edgePaths.get(e.id);
    if (!pair) continue;
    pair.vis.classList.toggle("lit", S.selected.has(e.from.node) || S.selected.has(e.to.node));
    pair.vis.classList.toggle("selected", S.selectedEdge === e.id);
  }
}

export function setSelection(ids: Set<string>) {
  S.selected = ids;
  S.selectedEdge = null;
  applySelectionClasses();
  notifyInspector();
}

// Edge selection/deletion lives in edges.ts; it notifies this callback so
// selection classes and the inspector stay in sync without edges.ts
// importing selection.ts or inspector.ts.
onEdgeSelectionChanged(() => {
  applySelectionClasses();
  notifyInspector();
});

/** The popover card (popover.ts) sits on `document.body`, outside `S.rootEl`, so
 *  focus in the card used to fail the `S.rootEl.contains(ae)` check outright and silently block
 *  Delete/arrows/0 from ever reaching a focused control there. Focus inside the card now counts
 *  the same as focus inside the root, for every one of INPUT/TEXTAREA/SELECT (not just the two
 *  root ever excluded) — a select in the card (the retries chip) gets the same carve-out a text
 *  field does, so Delete on it edits the value instead of deleting the node. */
export function keyboardAllowed(): boolean {
  const ae = document.activeElement;
  if (!ae || ae === document.body) return true;
  const inRoot = S.rootEl.contains(ae);
  const inCard = !!S.inspectorEl && S.inspectorEl.contains(ae);
  if (!inRoot && !inCard) return false;
  const tag = ae.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if ((ae as HTMLElement).isContentEditable) return false;
  return true;
}

export function beginMarquee(e: PointerEvent) {
  S.canvasEl.setPointerCapture(e.pointerId);
  const p = canvasPoint(e);
  const el = document.createElement("div");
  el.className = "flow-marquee";
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
  el.style.width = "0px";
  el.style.height = "0px";
  S.canvasEl.appendChild(el);
  S.dragging = { kind: "marquee", startX: p.x, startY: p.y, el };
}

/** Move-time body for an in-flight marquee, dispatched from panels/flow.ts's
 *  onPointerMove by drag kind. */
export function onMarqueeMove(d: import("./state").MarqueeDrag, e: PointerEvent) {
  const p = canvasPoint(e);
  const left = Math.min(d.startX, p.x);
  const top = Math.min(d.startY, p.y);
  d.el.style.left = `${left}px`;
  d.el.style.top = `${top}px`;
  d.el.style.width = `${Math.abs(p.x - d.startX)}px`;
  d.el.style.height = `${Math.abs(p.y - d.startY)}px`;
}

export function finishMarquee(d: import("./state").MarqueeDrag, e: PointerEvent) {
  const p = canvasPoint(e);
  const left = Math.min(d.startX, p.x);
  const right = Math.max(d.startX, p.x);
  const top = Math.min(d.startY, p.y);
  const bottom = Math.max(d.startY, p.y);
  const hit = new Set<string>();
  for (const n of S.nodes) {
    const el = S.nodeEls.get(n.id);
    if (!el) continue;
    const nx0 = n.x * S.scale + S.panX;
    const ny0 = n.y * S.scale + S.panY;
    const nx1 = nx0 + el.offsetWidth * S.scale;
    const ny1 = ny0 + el.offsetHeight * S.scale;
    if (nx0 < right && nx1 > left && ny0 < bottom && ny1 > top) hit.add(n.id);
  }
  d.el.remove();
  if (e.shiftKey) setSelection(new Set([...S.selected, ...hit]));
  else setSelection(hit);
}
