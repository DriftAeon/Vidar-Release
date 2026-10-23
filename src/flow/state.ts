// Single owner of Flow's mutable view state. Every other flow/* module reads
// and writes `S.<field>` instead of declaring its own module-level `let` —
// the module-boundary rule's "state private, crosses via exports" clause,
// satisfied here by one shared owner rather than by scattering.

import type { FlowEdge, FlowGraph, FlowNode, FlowTemplate } from "./model";
import type { FlowRunNodeStatus, FlowRunNodeOutput, FlowPendingApproval } from "./run";

export const SVG_NS = "http://www.w3.org/2000/svg";
/** generous fixed extent — the mock graph's world coordinates never exceed this */
export const WORLD_W = 1800;
export const WORLD_H = 700;
export const NODE_W = 240;

/** Zoom stops, ascending; 1 = 1 world px per screen px. Wheel and fit land only on these,
 *  so the toast reads 100%, not 102% (a ×1.1 step and a raw fit ratio drifted off-grid). */
export const SCALE_STOPS = [0.4, 0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
export const SCALE_MIN = SCALE_STOPS[0];

/** each edge gets a visible path plus an invisible wider "hit" twin
 *  underneath it (painted first) so thin strokes stay easy to click. */
export type EdgePathPair = { vis: SVGPathElement; hit: SVGPathElement };

/** @public used via inline `import("./state").NodeDrag` (nodes.ts), which knip does not trace */
export type NodeDrag = {
  kind: "node";
  id: string;
  startX: number;
  startY: number;
  /** every dragged node's start position, keyed by id — the whole selection
   *  when the pressed node is already selected, just that node otherwise */
  starts: Map<string, { x: number; y: number }>;
  moved: boolean;
};
/** @public used via inline `import("./state").PanDrag` (viewport.ts) */
export type PanDrag = { kind: "pan"; startX: number; startY: number; panX: number; panY: number };
/** @public used via inline `import("./state").MarqueeDrag` (selection.ts) */
export type MarqueeDrag = { kind: "marquee"; startX: number; startY: number; el: HTMLElement };
/** @public used via inline `import("./state").EdgeDrag` (edges.ts) */
export type EdgeDrag = { kind: "edge"; from: string; draft: SVGPathElement };
export type Drag = NodeDrag | PanDrag | MarqueeDrag | EdgeDrag | null;

export const S = {
  rootEl: undefined as unknown as HTMLElement,
  canvasEl: undefined as unknown as HTMLElement,
  worldEl: undefined as unknown as HTMLElement,
  edgesEl: undefined as unknown as SVGSVGElement,
  inspectorEl: undefined as unknown as HTMLElement,

  nodes: [] as FlowNode[],
  /** mutable working copy of the active graph (store.ts), written back into it on each
   *  debounced save; Reset layout reseeds it from a starter template (templates.ts). */
  edges: [] as FlowEdge[],
  nodeEls: new Map<string, HTMLElement>(),
  edgePaths: new Map<string, EdgePathPair>(),
  selected: new Set<string>(),
  selectedEdge: null as string | null,

  panX: 0,
  panY: 0,
  scale: 1,

  dragging: null as Drag,
  /** set by endDrag right before it clears `dragging`, so the node's trailing
   *  click event (which fires after pointerup) can tell a drag from a tap */
  lastNodeDragMoved: false,
  /** set by a node's pointerdown when it already applied the selection change
   *  for an unselected node — the trailing click, if stationary, must not redo it */
  selectionHandledOnDown: false,

  edgesDirty: false,
  rafActive: false,
  fitted: false,

  saveTimer: undefined as number | undefined,

  // --- additive fields ---
  // store.ts, engine.ts and run-view.ts read/write these.
  graphs: [] as FlowGraph[],
  activeGraphId: null as string | null,
  /** An unsaved template instance (store.ts's `applyTemplateDraft`): the canvas's graph while
   *  `activeGraphId` equals its id. Never in `graphs`, never persisted; Save (`saveDraft`) moves
   *  it into `graphs` under the same id, any switch drops it. */
  draftGraph: null as FlowGraph | null,
  templates: [] as FlowTemplate[],
  activeRunId: null as string | null,
  /** key = `${runId}:${nodeId}` */
  runNodeStatus: new Map<string, FlowRunNodeStatus>(),
  /** key = `${runId}:${nodeId}:${port}:${attempt}`, in-memory only, cleared on reload */
  runOutputs: new Map<string, FlowRunNodeOutput>(),
  /** key = permission id (the sidecar's UUID); one entry per outstanding request, so
   *  parallel tool_use blocks never overwrite each other. Removed when answered, and
   *  every entry for a node is dropped when that node reaches a terminal status.
   *  In-memory only: a reload interrupts the run (§4.1), so there is nothing to rehydrate. */
  pendingApprovals: new Map<string, FlowPendingApproval>(),
  GRID: 16, // matches --space-16
};

const pendingListeners = new Set<() => void>();

/** Subscribes to every change of `S.pendingApprovals` (add, answer, node end, cancel); returns the unsubscribe. */
export function onPendingApprovalsChanged(fn: () => void): () => void {
  pendingListeners.add(fn);
  return () => pendingListeners.delete(fn);
}

/** Call after every write to `S.pendingApprovals`. */
export function notifyPendingApprovalsChanged(): void {
  for (const fn of [...pendingListeners]) fn();
}

/** Canvas-relative pointer position — shared by marquee (selection.ts) and
 *  edge-drag (edges.ts); kept here rather than duplicated since it only
 *  reads S.canvasEl and has no state of its own. */
export function canvasPoint(e: PointerEvent): { x: number; y: number } {
  const rect = S.canvasEl.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/** Tiny DOM util used by both nodes.ts (node/chip labels) and inspector.ts
 *  (field rows) — kept here rather than duplicated. */
export function text(cls: string, s: string): HTMLElement {
  const el = document.createElement("span");
  if (cls) el.className = cls;
  el.textContent = s;
  return el;
}
