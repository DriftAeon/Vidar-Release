// Anchored node-details popover: replaces the
// old docked Details panel. Owns the popover/connector element lifecycle and focus handling —
// content and field editing/persistence stay in inspector.ts, position/follow/flip in
// popover-position.ts (one concern per file, per the brief).
//
// The card and connector mount on `document.body`,
// `position: fixed` — not as canvas children — so the canvas's own pointerdown/wheel/dblclick
// (clear selection, zoom, fit-to-view) never reach them; this module still stops all three at the
// card root anyway, since a press or wheel over the card must never fall through to whatever is
// behind it at that screen point. popover-position.ts converts the node's canvas-local position to
// viewport coordinates via S.canvasEl.getBoundingClientRect().
//
// No focus trap: focus moves into the card on open, back to the node on close (deselect, × or Esc).
// Esc clears the selection via panels/flow.ts's document keydown when focus is elsewhere on the
// page, but selection.ts's keyboardAllowed() blocks that handler while focus sits in the card's own
// Task/Content textarea — this module's own keydown on the card root covers that case.
// Every path that closes the card goes through selection.ts's setSelection, so this module only
// needs the one onSelectionChanged hook plus its own Esc listener.

import { S } from "./state";
import type { FlowNode } from "./model";
import { onSelectionChanged, setSelection } from "./selection";
import { renderInspector, updateLiveOutput, setOpenInDocumentCb } from "./inspector";
import { closeAddonMenu } from "./modifiers";
import { positionPopover } from "./popover-position";
import "./inspector.css";

let connectorEl: HTMLElement | null = null;
/** The node id the card is currently showing, so a render that lands on the same node (a run
 *  event mid-typing, say) doesn't re-steal focus into the card every time. */
let openNodeId: string | null = null;
let suspended = false;

function selectedNode(): FlowNode | null {
  if (S.selected.size !== 1) return null;
  const id = [...S.selected][0];
  return S.nodes.find((n) => n.id === id) ?? null;
}

function hide(): void {
  closeAddonMenu();
  if (openNodeId) {
    // Focus back to the node (brief: "focus moves ... back to the node on close").
    S.nodeEls.get(openNodeId)?.focus({ preventScroll: true });
  }
  openNodeId = null;
  S.inspectorEl.style.display = "none";
  if (connectorEl) connectorEl.style.display = "none";
}

export function renderPopover(): void {
  if (suspended) return;
  const node = selectedNode();
  if (!node) {
    // openNodeId is the single source of truth — hide unconditionally whenever
    // the selection isn't exactly one node, even when the card's own `display` is already "none"
    // (off-canvas hiding in popover-position.ts sets that directly, without touching openNodeId,
    // so checking `display` here left openNodeId stale and the card reappeared on the next pan).
    hide();
    return;
  }
  const isNewOpen = openNodeId !== node.id;
  openNodeId = node.id;
  S.inspectorEl.style.display = "";
  if (connectorEl) connectorEl.style.display = "";

  // A text field mid-edit (typing in the Task/Content textarea, a retries select, an addon's
  // inline input) must not be rebuilt out from under the user — every other run event (up to 4Hz
  // while a node is live, for the Live output line) still repaints, so a rebuild is only skipped
  // while focus is actually inside an editable control, not merely inside the card — the same
  // INPUT/TEXTAREA/SELECT set selection.ts's keyboardAllowed() now excludes when focus sits in
  // this card (it used to exempt only INPUT/TEXTAREA there, letting Delete/arrows/0 reach a
  // focused retries select — modifiers.ts's stopSelectKeys() still stops those at the select itself
  // as a second line of defence).
  const ae = document.activeElement;
  const editing = !!ae && S.inspectorEl.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT");
  if (!isNewOpen && editing) {
    repositionPopover();
    return;
  }

  // While the node is running, the Live line repaints at up to 4Hz off run-node events
  // (panels/flow.ts's onFlowNodeEvent) — a full renderInspector() on every one of those replaced
  // every element in the card, resetting scroll, wiping the open addon menu and dropping focus.
  // updateLiveOutput() patches just the `.flow-pop-live` text node in place and pins its scroll to
  // the bottom; it only returns true once that element already exists (i.e. not the first render
  // after selection settles, and not once the run has moved past the locked/live state).
  if (!isNewOpen && updateLiveOutput(node)) {
    repositionPopover();
    return;
  }

  // Known gap: a full rebuild (still needed on open, on the running/not-running transition, and on
  // any in-card edit) replaces every element in the card, so focus that was on a non-editable
  // control inside it (e.g. the × button) is lost to the body rather than restored.
  renderInspector(node);
  const nodeEl = S.nodeEls.get(node.id);
  const kind = nodeEl ? getComputedStyle(nodeEl).getPropertyValue("--kind").trim() : "";
  if (kind) {
    S.inspectorEl.style.setProperty("--k", kind);
    connectorEl?.style.setProperty("--k", kind);
  }
  if (connectorEl) positionPopover(S.inspectorEl, connectorEl, node);
  if (isNewOpen) {
    const focusable = S.inspectorEl.querySelector<HTMLElement>("button, [tabindex], input, textarea, select");
    (focusable ?? S.inspectorEl).focus();
  }
}

/** Called from panels/flow.ts's frame loop alongside redrawEdges, so the card tracks pan/zoom/drag
 *  exactly like an edge does. No-op with nothing open. */
export function repositionPopover(): void {
  if (suspended || !openNodeId || !connectorEl) return;
  const node = S.nodes.find((n) => n.id === openNodeId);
  if (!node) return;
  positionPopover(S.inspectorEl, connectorEl, node);
}

/** Keep the selected card's identity while an edge drag needs the canvas clear. */
export function suspendPopover(on: boolean): void {
  if (suspended === on) return;
  suspended = on;
  if (on) {
    S.inspectorEl.style.display = "none";
    if (connectorEl) connectorEl.style.display = "none";
    return;
  }
  const node = selectedNode();
  if (!node || node.id !== openNodeId) {
    renderPopover();
    return;
  }
  S.inspectorEl.style.display = "";
  if (connectorEl) connectorEl.style.display = "";
  repositionPopover();
}

/** Builds the card and connector once, appended to `document.body` (not the canvas, so
 *  `.flow-canvas { overflow: hidden }` never clips the card or its ADD menu, and the canvas's own
 *  pointerdown/wheel/dblclick land on the canvas, not the card) — call once at Flow mount.
 *  `positionPopover` still places both in the same screen-space coordinate system pan/zoom/drag
 *  already use (selection.ts's marquee hit-test uses the same n.x*scale+panX math), by adding the
 *  canvas's own viewport offset.
 *
 *  `openPathInDocument`: the Output card's "Open in Document" button hands a written document path
 *  to this (workbench.ts's existing tray "Open" callback, threaded down through mountFlowView —
 *  the same inversion mountDocumentView uses for its own "open the Document tab" callback). */
export function initPopover(openPathInDocument: (path: string) => void): void {
  S.inspectorEl = document.createElement("div");
  S.inspectorEl.className = "flow-pop";
  S.inspectorEl.style.display = "none";
  S.inspectorEl.tabIndex = -1;
  // Stop every one of the canvas's own drag/zoom/fit gestures at the card root — belt-and-
  // braces alongside the body mount above, since a press or wheel over the card must never reach
  // whatever sits behind it on screen (the pattern panels/flow.ts's Reset Layout button already
  // uses on pointerdown, ~line 395).
  S.inspectorEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  S.inspectorEl.addEventListener("wheel", (e) => e.stopPropagation());
  S.inspectorEl.addEventListener("dblclick", (e) => e.stopPropagation());
  // selection.ts's keyboardAllowed() blocks panels/flow.ts's document-level Escape
  // handler while focus sits in the card's Task/Content textarea, so Esc otherwise did nothing.
  S.inspectorEl.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setSelection(new Set());
  });
  document.body.appendChild(S.inspectorEl);

  connectorEl = document.createElement("div");
  connectorEl.className = "flow-pop-connector";
  connectorEl.style.display = "none";
  document.body.appendChild(connectorEl);

  setOpenInDocumentCb(openPathInDocument);
  onSelectionChanged(renderPopover);
}

/** Called by panels/flow.ts's disposeFlowView: the card and connector are `document.body`
 *  children, so removing #flow-view alone leaves them behind. */
export function disposePopover(): void {
  S.inspectorEl?.remove();
  connectorEl?.remove();
  connectorEl = null;
  openNodeId = null;
  suspended = false;
}

/** Called by panels/flow.ts's onFlowShown/onFlowHidden: a body-fixed card sits outside
 *  `#flow-view { display: none }`, so it would otherwise float over whichever workbench tab (or no
 *  tab, workbench collapsed) is on screen once Flow itself isn't. Showing again repositions off the
 *  live node rect rather than trusting the last-known screen position. */
export function setFlowVisible(v: boolean): void {
  if (v) {
    repositionPopover();
    return;
  }
  S.inspectorEl.style.display = "none";
  if (connectorEl) connectorEl.style.display = "none";
}
