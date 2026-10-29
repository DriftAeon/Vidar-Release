// Positions the anchored node-details popover and its connector line relative to the selected node's on-canvas box.
//
// `card`/`connector` are not children of
// S.canvasEl, so a press on the card landed on the canvas underneath it too (selection cleared,
// wheel zoomed, dblclick fit-to-view) and `.flow-canvas { overflow: hidden }` clipped the card and
// its ADD menu. Both are now children of `document.body`, `position: fixed` — this module converts
// the node's canvas-local screen position (n.x*scale+panX, the same math selection.ts's marquee
// hit-test uses) into viewport coordinates via S.canvasEl.getBoundingClientRect(), and popover.ts
// stops pointerdown/wheel/dblclick at the card root so the canvas underneath never sees them.
//
// Recomputed every frame the transform or a drag moves (panels/flow.ts's frame loop calls
// popover.ts's repositionPopover alongside redrawEdges; viewport.ts's applyWorldTransform and a
// ResizeObserver on the canvas both schedule that frame).
//
// Connector geometry: a GAP-px gap between node and card, a CONNECTOR_LEN-px line overlapping a few px into the
// card. The connector stays at the node header even when the card moves up, no arrowhead.

import { S, NODE_W } from "./state";
import type { FlowNode } from "./model";

const GAP = 16;
const CONNECTOR_LEN = 28;
const CARD_W = 300;
const ANCHOR_TOP_OFFSET = 14; // card's top sits 14px above the node's top edge (mock: top:-14)

/** `card` and `connector` are children of `document.body` — every coordinate below is
 *  canvas-local until the final assignment, which adds the canvas's own viewport offset. Flips
 *  left when the right side would leave the canvas, shifts up only as far as needed when there
 *  isn't room below, and hides both elements outright once the node has panned/zoomed
 *  fully outside the canvas rect (a body-fixed card with no anchor on screen would otherwise
 *  float over whatever the canvas no longer shows). */
export function positionPopover(card: HTMLElement, connector: HTMLElement, node: FlowNode): void {
  const nodeEl = S.nodeEls.get(node.id);
  if (!nodeEl) {
    // A missing node element (mid loadGraph rebuild, say) is a hide, not a silent no-op — a
    // no-op left the card showing wherever it last was positioned.
    card.style.display = "none";
    connector.style.display = "none";
    return;
  }
  const canvasRect = S.canvasEl.getBoundingClientRect();
  const canvasW = canvasRect.width;
  const canvasH = canvasRect.height;
  const nodeLeft = node.x * S.scale + S.panX;
  const nodeTop = node.y * S.scale + S.panY;
  const screenW = (nodeEl.offsetWidth || NODE_W) * S.scale;
  const screenH = nodeEl.offsetHeight * S.scale;

  const outOfView = nodeLeft + screenW < 0 || nodeLeft > canvasW || nodeTop + screenH < 0 || nodeTop > canvasH;
  if (outOfView) {
    card.style.display = "none";
    connector.style.display = "none";
    return;
  }
  card.style.display = "";
  connector.style.display = "";

  const fitsRight = nodeLeft + screenW + GAP + CARD_W <= canvasW;
  const fitsLeft = nodeLeft - GAP - CARD_W >= 0;
  const side: "right" | "left" = fitsRight || !fitsLeft ? "right" : "left";
  const xLocal = side === "right" ? nodeLeft + screenW + GAP : nodeLeft - GAP - CARD_W;
  const connXLocal = side === "right" ? nodeLeft + screenW : nodeLeft - CONNECTOR_LEN;

  const headerEl = nodeEl.querySelector<HTMLElement>(".flow-node-header");
  const headerCenterYLocal = nodeTop + ((headerEl?.offsetHeight ?? 24) * S.scale) / 2;

  // Cap before measuring, independently of the previous position. A position-dependent cap
  // made the next pan/zoom pass measure a different height and jump to another placement.
  const availableH = Math.max(0, Math.min(canvasH, window.innerHeight - canvasRect.top) - 8);
  card.style.boxSizing = "border-box";
  card.style.maxHeight = `${availableH}px`;
  const cardH = card.offsetHeight || Math.min(200, availableH);
  const desiredTopLocal = nodeTop - ANCHOR_TOP_OFFSET;

  const clampedXLocal = Math.max(0, Math.min(xLocal, Math.max(0, canvasW - CARD_W)));
  const clampedTopLocal = Math.max(0, Math.min(desiredTopLocal, availableH - cardH));

  const cardTop = canvasRect.top + clampedTopLocal;
  card.style.left = `${canvasRect.left + clampedXLocal}px`;
  card.style.top = `${cardTop}px`;
  // Never move the node endpoint to follow the card header: that points at unrelated nodes.
  // If the header is clipped or the card cannot reach it, omit the line instead of misanchoring it.
  const connYLocal = headerCenterYLocal;
  if (connYLocal < clampedTopLocal || connYLocal > clampedTopLocal + cardH) {
    connector.style.display = "none";
  }

  connector.style.left = `${canvasRect.left + connXLocal}px`;
  connector.style.top = `${canvasRect.top + connYLocal - 1}px`;
  connector.style.width = `${CONNECTOR_LEN}px`;
}
