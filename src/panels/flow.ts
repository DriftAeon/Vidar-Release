// Flow tab: a node-graph editor. Drag, pan, select (multi-select with shift-click and
// shift-drag marquee), group drag, keyboard nudge/delete, wheel zoom (capped), fit-to-view
// (dblclick empty canvas or the 0 key, once automatically on first show), a transient
// zoom-percent toast, kind-coloured orthogonal edges (route.ts) that light up when either endpoint is
// selected, a first-field preview line plus addon chips on each node body, edge creation by
// dragging from an out-port to another node's in-port, click-to-select and Delete on an edge,
// an anchored node-details popover (popover.ts) with click-to-edit title and field values, layout
// persistence in vidar-state.json (store.ts) — plus a
// toolbar: the flow picker + New, the run selector, RUN and Cancel (run-controls.ts), then the
// Tidy (tidy.ts) and the ADD node-palette button, that drive engine.ts and paint from run-view.ts.
//
// This file is wiring only: DOM shell, event listeners, and drag dispatch by kind to the
// module that owns that kind's per-move/end/cancel body, plus the toolbar controls each
// flow/* module already builds. Every other concern lives under src/flow/.

import { iconImg } from "../icon-img";
import { paneShell } from "./pane-shell";
import type { FlowGraph } from "../flow/model";
import { S, SVG_NS, WORLD_W, WORLD_H } from "../flow/state";
import { initFrameLoop, scheduleFrame, applyWorldTransform, onWheel, fitToView, beginPan, onPanMove, visible, showFlowToast } from "../flow/viewport";
import { initStore, scheduleGraphSave, cancelPendingGraphSave, flushGraphSave, flushPendingGraphSave, applyTemplateDraft, activeDraft, noGraphOpen, onGraphEdited, onSaveFailed } from "../flow/store";
import { redrawEdges, onEdgeDragMove, finishEdgeDrag, deleteSelectedEdge } from "../flow/edges";
import { setSelection, beginMarquee, onMarqueeMove, finishMarquee, keyboardAllowed } from "../flow/selection";
import { loadGraph, onNodeDragMove, deleteSelected, nudgeSelected } from "../flow/nodes";
import { unobserveAllNodes } from "../flow/node-resize";
import { initPopover, renderPopover, repositionPopover, setFlowVisible, suspendPopover, disposePopover } from "../flow/popover";
import { buildTidyButton } from "../flow/tidy";
import { buildSaveButton } from "../flow/save-button";
import { initGridOpacity } from "../flow/grid-opacity";
import { buildFlowPicker,buildNewFlowButton, createBlankFlow, DEFAULT_NAME } from "../flow/flow-picker";
import { openNodeKindPalette } from "../flow/palette";
import { heldRunIds, initEngine } from "../flow/engine";
import { initRunsStore, onSaveFailed as onRunsSaveFailed, onRunStatusChanged } from "../flow/runs-store";
import { onFlowNodeEvent } from "../flow/runner-adapter";
import { flushFlowStorage, onFlowStorageError } from "../flow/file-storage";
import { resetRunView, initRunView } from "../flow/run-view";
import { buildRunControls } from "../flow/run-controls";

/** What a mount registered outside its own root (observer, subscriptions, window/document
 *  listeners), undone by disposeFlowView. */
const teardown: Array<() => void> = [];

/** Undoes mountFlowView. The app never unmounts Flow (workbench.ts mounts it once); this is
 *  the seam the mount contract test (tests/flow-mount.test.mjs) and a future unmount use. */
export function disposeFlowView(): void {
  for (const undo of teardown.splice(0)) undo();
  onFlowStorageError(null);
  disposePopover();
  S.rootEl?.remove();
  S.fitted = false;
}

function onPointerMove(e: PointerEvent) {
  if (!S.dragging) return;
  if (S.dragging.kind === "node") onNodeDragMove(S.dragging, e);
  else if (S.dragging.kind === "pan") onPanMove(S.dragging, e);
  else if (S.dragging.kind === "marquee") onMarqueeMove(S.dragging, e);
  else onEdgeDragMove(S.dragging, e);
}

function endDrag(e: PointerEvent) {
  if (S.dragging?.kind === "marquee") finishMarquee(S.dragging, e);
  else if (S.dragging?.kind === "edge") finishEdgeDrag(S.dragging, e);
  const wasEdge = S.dragging?.kind === "edge";
  const wasNode = S.dragging?.kind === "node";
  S.lastNodeDragMoved = S.dragging?.kind === "node" ? S.dragging.moved : false;
  S.dragging = null;
  if (wasEdge) suspendPopover(false);
  if (wasNode) scheduleGraphSave();
}

function cancelDrag() {
  const wasEdge = S.dragging?.kind === "edge";
  if (S.dragging?.kind === "marquee") S.dragging.el.remove();
  else if (S.dragging?.kind === "edge") S.dragging.draft.remove();
  S.dragging = null;
  if (wasEdge) suspendPopover(false);
}

/** Called by workbench.ts's setTab when Flow becomes the shown tab: `display:none`
 *  gives every node a zero-size box, so the first edge layout has to wait for
 *  the tab to actually be on screen. */
export function onFlowShown() {
  scheduleFrame();
  setFlowVisible(true);
  if (!S.fitted) {
    S.fitted = true;
    fitToView();
  }
}

/** Called by workbench.ts's setTab/setWorkbenchShown right before Flow stops being the shown tab
 *  (a tab switch, or the workbench pane collapsing) — the popover card is a
 *  `document.body` child (`position: fixed`), so unlike the rest of #flow-view it isn't hidden for
 *  free by `display: none` on the tab root; left alone it would float over whatever comes on
 *  screen next. */
export function onFlowHidden() {
  setFlowVisible(false);
}

/** World-space point roughly at the center of the visible canvas — where the `+` palette drops a
 *  new node (palette.ts takes the position as a parameter; picking a real one is this module's
 *  job per its own doc). */
function paletteDropPoint(): { x: number; y: number } {
  const rect = S.canvasEl.getBoundingClientRect();
  return { x: (rect.width / 2 - S.panX) / S.scale, y: (rect.height / 2 - S.panY) / S.scale };
}

/** Builds the node palette button (`palette.ts`) — reads "ADD",
 *  filled green, same class/title/handler as the old `+`. */
function buildPlusButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "flow-plus-btn icon-btn";
  btn.title = "Add Node";
  btn.setAttribute("aria-label", "Add");
  btn.appendChild(iconImg("plus"));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (noGraphOpen()) return;
    openNodeKindPalette(btn, paletteDropPoint());
  });
  return btn;
}

/** Builds the view into `parent` (hidden until the Flow tab is picked). `openPathInDocument`
 *  reveals the Document tab on a written path — workbench.ts's existing tray "Open" callback,
 *  threaded down for the popover's Output card (same inversion mountDocumentView uses for its
 *  own "open the Document tab" callback). */
export function mountFlowView(parent: HTMLElement, openPathInDocument: (path: string) => void): HTMLElement {
  const shell = paneShell({ id: "flow-view", head: { cls: "flow-toolbar" }, frame: { cls: "flow-body" } });
  S.rootEl = shell.root;
  S.rootEl.style.display = "none";
  initGridOpacity();
  shell.frame.innerHTML = `
    <div class="flow-canvas">
      <div class="flow-world"></div>
      <div class="cx-empty flow-empty" hidden>Open a Flow or Start a New One</div>
      <button type="button" class="flow-reset">Reset Layout</button>
    </div>`;

  const toolbarEl = shell.head;
  S.canvasEl = S.rootEl.querySelector<HTMLElement>(".flow-canvas")!;
  S.worldEl = S.rootEl.querySelector<HTMLElement>(".flow-world")!;
  // A canvas resize (workbench collapse/expand, window resize) moves the node's screen
  // position under the body-fixed popover card without any pan/zoom/drag event firing — schedule a
  // frame so repositionPopover (riding the same loop as redrawEdges, below) picks it up.
  const ro = new ResizeObserver(() => scheduleFrame());
  ro.observe(S.canvasEl);
  teardown.push(() => ro.disconnect());
  teardown.push(unobserveAllNodes);
  // Popover: no docked Details panel — selecting
  // a node opens a card anchored beside it (popover.ts), positioned in the same screen-space
  // coordinate system pan/zoom/drag already use, so it must mount after S.canvasEl exists.
  initPopover(openPathInDocument);
  // repositionPopover rides the same dirty-frame loop redrawEdges already uses (pan/zoom/drag all
  // set S.edgesDirty) — the card tracks the node exactly like an edge does.
  initFrameLoop(() => {
    redrawEdges();
    repositionPopover();
  });

  S.edgesEl = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  S.edgesEl.setAttribute("class", "flow-edges");
  S.edgesEl.setAttribute("width", String(WORLD_W));
  S.edgesEl.setAttribute("height", String(WORLD_H));
  S.worldEl.appendChild(S.edgesEl);
  // No arrowhead markers: edges end vertical-down into the in-port
  // triangle, which reads as the arrow.

  // Registered before initStore/initRunsStore so their first saves and the file store's init
  // failures (replayed on registration) all reach the toast. A refused store write is otherwise
  // silent; both stores share the one Flow toast surface
  // (viewport.ts's showFlowToast), shown longer than the zoom toast's 0.5s so it's readable.
  // While the store is read-only, a save failure repeats the reason instead of hiding it behind
  // "Flow Save Failed".
  let readOnlyToast: string | null = null;
  const saveFailed = (): void => showFlowToast(readOnlyToast ?? "Flow Save Failed", readOnlyToast ? 5000 : 3000);
  onFlowStorageError((kind, _keys, err) => {
    if (kind === "save") {
      saveFailed();
      return;
    }
    console.error(`flow: storage ${kind}: ${err}`);
    readOnlyToast =
      kind === "locked" ? "Flow Is Open in Another Vidar"
      : kind === "lockfailed" ? "Flow Is Read-Only: Can't Open Lock File"
      : "Flow File Unreadable";
    showFlowToast(readOnlyToast, 5000);
  });
  onSaveFailed(saveFailed);
  onRunsSaveFailed(saveFailed);
  initStore();
  // First load, no legacy layout to migrate: store-core.ts's seedGraphsIfAbsent deliberately
  // never seeds a graph itself (§7: "Never seeds MOCK_GRAPH") — this mount fills that gap from
  // the first starter template (always present: store.ts seeds templates unconditionally),
  // rather than an empty canvas with nothing to Reset to or Run. Applied as an unsaved instance:
  // user graphs come only from Save (2026-10-05). Only with no user graphs at all: saved
  // graphs with none active (the open one was deleted) stay empty until New or a template.
  if (S.graphs.length === 0) {
    const seeded = S.templates[0] ? applyTemplateDraft(S.templates[0].id) : null;
    // Defensive only (no template either, which never happens in practice — store.ts always
    // seeds S.templates from templates.ts): the same blank input->output pair New builds.
    if (!seeded) createBlankFlow(DEFAULT_NAME);
  }
  const activeGraph = S.graphs.find((g) => g.id === S.activeGraphId) ?? activeDraft();
  if (activeGraph) loadGraph(activeGraph);

  const runControls = buildRunControls();
  const plusBtn = buildPlusButton();
  const picker = buildFlowPicker((graph) => onGraphSwitched(graph));
  teardown.push(picker.destroy);
  const newBtn = buildNewFlowButton(picker,(graph) => onGraphSwitched(graph));
  const saveBtn = buildSaveButton(() => picker.refresh());
  const tidyBtn = buildTidyButton();
  const emptyEl = S.rootEl.querySelector<HTMLElement>(".flow-empty")!;
  const resetBtn = S.rootEl.querySelector<HTMLButtonElement>(".flow-reset")!;

  /** No flow open: the empty-state line shows and every graph-editing control is off (Run gates
   *  itself on `currentGraph()`); New and the picker's templates stay live. */
  function syncOpenState(): void {
    const none = noGraphOpen();
    emptyEl.hidden = !none;
    resetBtn.hidden = none;
    plusBtn.disabled = none;
    tidyBtn.disabled = none;
  }

  function onGraphSwitched(_graph: FlowGraph | null): void {
    syncOpenState();
    saveBtn.refresh();
    S.activeRunId = null;
    resetRunView();
    runControls.refresh();
    runControls.updateRunGate();
    renderPopover();
    scheduleFrame();
  }

  // Order: flow picker, New, run selector,
  // Run · Cancel, spacer, Save, Tidy, ADD. Tidy is not in the mock but stays (no agreed removal);
  // Save sits left of Tidy (2026-10-05).
  const spacer = document.createElement("div");
  spacer.className = "flow-toolbar-spacer";
  toolbarEl.append(picker.el, newBtn, runControls.runPick, runControls.runBtn, runControls.cancelBtn, spacer, saveBtn.el, tidyBtn, plusBtn);
  syncOpenState();

  initRunsStore(heldRunIds());
  // Must precede initRunView() — see the note above (subscriber order).
  initEngine();
  teardown.push(initRunView());
  // Every event for the selected node repaints the popover, including "running" ones — the
  // round-3 Live line (inspector.ts's buildResult) needs the mid-run text, not just the terminal
  // repaint the old docked panel settled for. Registered after initEngine, so the engine has
  // already written the node's result by the time a terminal event reaches here. popover.ts's own
  // renderPopover skips the rebuild while a card field has focus.
  teardown.push(onFlowNodeEvent((event) => {
    // Skip on the wrong run or a multi/no selection, and on any *other*
    // running node's ~4Hz Live-line events, which would rebuild the open card for whichever node actually
    // has focus — the nodeId check keeps a running node's events from touching a different node's
    // open card at all.
    if (event.runId !== S.activeRunId || S.selected.size !== 1 || !S.selected.has(event.nodeId)) return;
    renderPopover();
  }));
  runControls.refresh();
  runControls.updateRunGate();
  // Graph edits (palette node creation, edge drop, delete, inspector field/model/title edits) all
  // call store.ts's scheduleGraphSave, which fires this synchronously — without this the
  // palette's createNode path reached no recompute but the old 500 ms poll, so a new unconnected node
  // sat unmarked until the next tick (never, while the tab was hidden or the timer throttled).
  onGraphEdited(() => runControls.updateRunGate());
  // Close: write the debounced graph edit, then send everything pending at once. Best effort, like
  // prefs.ts. Residual loss window: on a window close main.rs's CloseRequested handler exits the
  // process about 500 ms later, and whether pagehide runs first is not verified; so an edit still
  // inside the 250 ms graph debounce, or a batch whose flow_store_write has not returned, can be
  // lost. What was on disk before stays whole: each file is replaced by an atomic rename.
  // Only a pending debounce is written: an unconditional flush re-stamped updatedAt on every close.
  const onPageHide = (): void => {
    flushPendingGraphSave();
    void flushFlowStorage();
  };
  window.addEventListener("pagehide", onPageHide);
  teardown.push(() => window.removeEventListener("pagehide", onPageHide));
  // State that changes without a graph edit: a run finishing (the gate's live-run check) and the
  // run selector's option text/Cancel state. runs-store.ts fires this after every `upsertRun`
  // (this replaces a 500 ms poll).
  onRunStatusChanged(() => {
    runControls.updateRunGate();
    // Refresh the run selector's own option the run selector's own option
    // text/Cancel state once a run finished — engine.ts's status changes reach run-view.ts's
    // canvas paint but never this toolbar. `refresh()` is cheap (one graph's runs) and preserves
    // the shown selection via `S.activeRunId`, set above on every explicit selector change.
    runControls.refresh();
  });

  resetBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (noGraphOpen()) return;
    cancelPendingGraphSave();
    const template = S.templates[0];
    const active = S.graphs.find((g) => g.id === S.activeGraphId);
    if (template && active) {
      if (!window.confirm("Replace this flow's nodes and edges with the starting template? This cannot be undone.")) return;
      const reset: FlowGraph = {
        id: active.id,
        name: active.name,
        nodes: structuredClone(template.graph.nodes),
        edges: structuredClone(template.graph.edges),
        updatedAt: new Date().toISOString(),
      };
      loadGraph(reset);
      // loadGraph rebuilds S.nodeEls with the reset graph's node
      // ids (template 0's, same ones the graph already had) but never dropped run-view.ts's stale
      // per-node badge cache, so a badge created against the old (now-detached) element kept
      // showing instead of the new one — same sequence onGraphSwitched already uses.
      resetRunView();
      runControls.refresh();
    }
    flushGraphSave();
    renderPopover();
    scheduleFrame();
    fitToView();
    runControls.updateRunGate();
  });

  S.canvasEl.addEventListener("pointerdown", (e) => {
    if (e.button === 1) e.preventDefault(); // block WebView2's middle-button autoscroll
    if (e.button === 0) {
      if (!e.shiftKey) setSelection(new Set());
      beginMarquee(e);
      return;
    }
    if (e.button === 1 || e.button === 2) beginPan(e);
  });
  S.canvasEl.addEventListener("pointermove", onPointerMove);
  S.canvasEl.addEventListener("pointerup", (e) => {
    endDrag(e);
    runControls.updateRunGate();
  });
  S.canvasEl.addEventListener("pointercancel", cancelDrag);
  // right-button pan must not end in the WebView2 context menu
  S.canvasEl.addEventListener("contextmenu", (e) => e.preventDefault());
  S.canvasEl.addEventListener("wheel", onWheel, { passive: false });
  S.canvasEl.addEventListener("dblclick", (e) => {
    // node dblclick already stops propagation, so any dblclick reaching here
    // landed on empty canvas
    e.preventDefault();
    fitToView();
  });

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!visible()) return;
    if (!keyboardAllowed()) return;
    if (e.key === "Escape") {
      setSelection(new Set());
      return;
    }
    // ctrlKey excluded so Ctrl+0 (terminal zoom reset) is untouched
    if (e.key === "0" && !e.ctrlKey) {
      fitToView();
      return;
    }
    // nothing open: Delete and the arrow nudges have no graph to change
    if (noGraphOpen()) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (S.selected.size) {
        e.preventDefault();
        deleteSelected();
        runControls.updateRunGate();
      } else if (S.selectedEdge) {
        e.preventDefault();
        deleteSelectedEdge();
        runControls.updateRunGate();
      }
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") { e.preventDefault(); nudgeSelected(-step, 0); }
    else if (e.key === "ArrowRight") { e.preventDefault(); nudgeSelected(step, 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); nudgeSelected(0, -step); }
    else if (e.key === "ArrowDown") { e.preventDefault(); nudgeSelected(0, step); }
  };
  document.addEventListener("keydown", onKeyDown);
  teardown.push(() => document.removeEventListener("keydown", onKeyDown));

  renderPopover();
  applyWorldTransform();
  scheduleFrame(); // initial edge layout, once the nodes have a box to measure

  parent.appendChild(S.rootEl);
  return S.rootEl;
}
