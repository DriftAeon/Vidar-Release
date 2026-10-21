// Node DOM building, node drag (single + group), delete/nudge, and
// (re)loading a graph into S.nodes/S.edges/DOM. loadGraph takes its graph
// as a parameter — panels/flow.ts passes it in at mount and on Reset layout
// (a template graph).

import { type FlowAddonKind, type FlowGraph, type FlowNode } from "./model";
import { fieldLabel, fieldValue, nodeSubtitle } from "./labels";
import { S, NODE_W, SVG_NS, text } from "./state";
import { scheduleFrame } from "./viewport";
import { observeNode, unobserveNode, unobserveAllNodes } from "./node-resize";
import { scheduleGraphSave } from "./store";
import { setSelection } from "./selection";
import { renderPopover, suspendPopover } from "./popover";
import { buildEdgePath, beginEdgeDrag, clearPortHighlight } from "./edges";
import { snapCoord, mintId, isValidId } from "./snap";

// Glyphs: two letters per kind, all ten distinct, v1's four
// (pa/sp/cw/rt) chosen first since those are the only ones the ADD picker (V1_ADDON_KINDS) ever
// shows; reserved kinds keep short mnemonic codes so the map stays exhaustive without implying
// they're offered.
const ADDON_GLYPH: Record<FlowAddonKind, string> = {
  "permission-allowlist": "pa",
  "system-prompt": "sp",
  cwd: "cw",
  retries: "rt",
  effort: "ef",
  budget: "bu",
  "loop-until": "lu",
  "fan-out": "fo",
  resume: "rs",
  "output-schema": "os",
};

export function buildAddonChip(kind: FlowAddonKind, label: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `flow-addon flow-addon-${kind}`;
  chip.title = fieldLabel(kind);
  // Stored graphs can carry pre-v1 addon kinds (rule/skill/model/hook/permission, e.g. the
  // migrated "Legacy layout"), which ADDON_GLYPH no longer maps: fall back to the kind's first two
  // letters so mount doesn't throw (validate.ts still rejects them for Run).
  const glyph = ADDON_GLYPH[kind] ?? String(kind).slice(0, 2);
  chip.append(text("flow-addon-k", glyph.toUpperCase()), document.createTextNode(fieldValue(kind, label)));
  return chip;
}

function beginNodeDrag(e: PointerEvent, node: FlowNode, el: HTMLElement) {
  el.setPointerCapture(e.pointerId);
  const ids = S.selected.has(node.id) && S.selected.size > 0 ? S.selected : new Set([node.id]);
  const starts = new Map<string, { x: number; y: number }>();
  for (const id of ids) {
    const n = S.nodes.find((nn) => nn.id === id);
    if (n) starts.set(id, { x: n.x, y: n.y });
  }
  S.dragging = { kind: "node", id: node.id, startX: e.clientX, startY: e.clientY, starts, moved: false };
  scheduleFrame();
}

/** Move-time body for an in-flight node (or group) drag, dispatched from
 *  panels/flow.ts's onPointerMove by drag kind. Snaps every dragged node's
 *  position to S.GRID (16px, matches --space-16) continuously during the
 *  drag (grid snap) — each node's own start position snaps
 *  independently, so a group drag keeps its relative layout only up to a
 *  16px rounding per node, the same shape as a single-node drag. */
export function onNodeDragMove(d: import("./state").NodeDrag, e: PointerEvent) {
  if (e.clientX !== d.startX || e.clientY !== d.startY) d.moved = true;
  const dx = (e.clientX - d.startX) / S.scale;
  const dy = (e.clientY - d.startY) / S.scale;
  for (const [id, start] of d.starts) {
    const n = S.nodes.find((nn) => nn.id === id);
    const el = S.nodeEls.get(id);
    if (!n || !el) continue;
    n.x = snapCoord(start.x + dx, S.GRID);
    n.y = snapCoord(start.y + dy, S.GRID);
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
  }
  S.edgesDirty = true;
}

export function deleteSelected() {
  if (S.selected.size === 0) return;
  const gone = S.selected;
  S.nodes = S.nodes.filter((n) => !gone.has(n.id));
  for (const id of gone) {
    const gEl = S.nodeEls.get(id);
    if (gEl) unobserveNode(gEl);
    gEl?.remove();
    S.nodeEls.delete(id);
  }
  S.edges = S.edges.filter((e) => {
    if (!gone.has(e.from.node) && !gone.has(e.to.node)) return true;
    const pair = S.edgePaths.get(e.id);
    pair?.vis.remove();
    pair?.hit.remove();
    S.edgePaths.delete(e.id);
    return false;
  });
  setSelection(new Set());
  scheduleFrame();
  scheduleGraphSave();
}

export function nudgeSelected(dx: number, dy: number) {
  if (S.selected.size === 0) return;
  for (const id of S.selected) {
    const n = S.nodes.find((nn) => nn.id === id);
    const el = S.nodeEls.get(id);
    if (!n || !el) continue;
    n.x += dx;
    n.y += dy;
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
  }
  S.edgesDirty = true;
  scheduleFrame();
  scheduleGraphSave();
}

/** A port: a hit-box span holding a flattened downward triangle (14x5), centred in the span by
 *  CSS so the span's own box is the one source for where edges meet it (edges.ts's portCenter).
 *  The in port's base sits on the card's top edge, the out port's on its bottom edge. */
function buildPort(side: "in" | "out"): HTMLElement {
  const p = document.createElement("span");
  p.className = `flow-port flow-port-${side}`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 14 5");
  const tri = document.createElementNS(SVG_NS, "polygon");
  tri.setAttribute("points", "0.5,0.5 13.5,0.5 7,4.5");
  svg.appendChild(tri);
  p.appendChild(svg);
  return p;
}

function buildNode(node: FlowNode): HTMLElement {
  const el = document.createElement("div");
  el.className = `flow-node flow-node-${node.kind}`;
  el.dataset.id = node.id;
  // Not in the tab order (no keyboard traversal of the canvas is defined) — only programmatically
  // focusable, so the popover (popover.ts) can move focus back here when it closes.
  el.tabIndex = -1;
  el.style.left = `${node.x}px`;
  el.style.top = `${node.y}px`;
  el.style.width = `${NODE_W}px`;

  // Header-band card (mock round 2, flow-details-mockups.html §00 / flow-mockups.html v06):
  // the kind colour fills the header instead of a left bar. `.flow-node-title`/`-subtitle`
  // keep their exact classes, just relocated here from the body, so inspector.ts's live
  // title/subtitle DOM patches (querySelector by class, not touched by this brief) keep working.
  const header = document.createElement("div");
  header.className = `flow-node-header flow-kind-${node.kind}`;
  header.appendChild(text("flow-node-title", node.title));
  if (node.subtitle) header.appendChild(text("flow-node-subtitle", nodeSubtitle(node.subtitle)));
  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "flow-node-body";
  if (node.fields.length) {
    const field = document.createElement("div");
    field.className = "flow-node-field";
    field.append(text("flow-node-field-k", `${fieldLabel(node.fields[0].k)}:`), text("flow-node-field-v", fieldValue(node.fields[0].k, node.fields[0].v)));
    body.appendChild(field);
  }
  if (node.addons && node.addons.length) {
    const row = document.createElement("div");
    row.className = "flow-node-addons";
    for (const a of node.addons) row.appendChild(buildAddonChip(a.kind, a.label));
    body.appendChild(row);
  }
  el.appendChild(body);

  // Run facts (time, cost — no per-node token count exists in FlowRunNodeState, see report)
  // footer; built empty/hidden here, filled by run-view.ts's paintNodeStatus once a run has them.
  const footer = document.createElement("div");
  footer.className = "flow-node-footer";
  footer.hidden = true;
  el.appendChild(footer);

  if (node.inputs.length) {
    // `.connected` (filled) is owned by edges.ts's redrawEdges, not set here
    el.appendChild(buildPort("in"));
  }
  if (node.outputs.length) {
    const p = buildPort("out");
    p.addEventListener("pointerdown", (e) => {
      // left button starts an edge drag instead of the node's own pointerdown
      // handler below (stopPropagation keeps that handler from also firing
      // and dragging the node); other buttons fall through to node drag/pan.
      if (e.button !== 0) return;
      e.stopPropagation();
      beginEdgeDrag(e, node.id);
      suspendPopover(true);
    });
    el.appendChild(p);
  }

  el.addEventListener("pointerdown", (e) => {
    // the in-port has no drag behaviour of its own — a left-button pointerdown
    // there still drags the whole node (or its whole selection); the out-port
    // is handled above and never reaches here. Other buttons fall through to
    // the canvas (pan).
    if (e.button !== 0) return;
    e.stopPropagation();
    S.selectionHandledOnDown = false;
    if (!S.selected.has(node.id)) {
      S.selectionHandledOnDown = true;
      if (e.shiftKey) {
        const next = new Set(S.selected);
        next.add(node.id);
        setSelection(next);
      } else {
        setSelection(new Set([node.id]));
      }
    }
    beginNodeDrag(e, node, el);
  });
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (S.lastNodeDragMoved) {
      S.lastNodeDragMoved = false;
      S.selectionHandledOnDown = false;
      return;
    }
    if (S.selectionHandledOnDown) {
      // pointerdown already applied the right selection for a stationary
      // click on a node that was not selected — redoing it here (esp. under
      // shift) would double-toggle it back off
      S.selectionHandledOnDown = false;
      return;
    }
    if (e.shiftKey) {
      const next = new Set(S.selected);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      setSelection(next);
    } else {
      setSelection(new Set([node.id]));
    }
  });
  // keep dblclick-to-fit (canvas) from firing when the dblclick lands on a node
  el.addEventListener("dblclick", (e) => e.stopPropagation());

  return el;
}

/** (Re)builds `S.nodes`/`S.edges` and every node/edge element from `graph`,
 *  clearing whatever was mounted before — used at mount (from a saved layout)
 *  and by Reset layout (a fresh template instance). */
export function loadGraph(graph: FlowGraph) {
  unobserveAllNodes();
  for (const el of S.nodeEls.values()) el.remove();
  for (const pair of S.edgePaths.values()) {
    pair.vis.remove();
    pair.hit.remove();
  }
  S.nodeEls = new Map();
  S.edgePaths = new Map();
  S.selected = new Set();
  S.selectedEdge = null;
  // a highlighted port from an in-flight edge drag would otherwise reference
  // a detached element after the reload
  clearPortHighlight();
  // This bypasses setSelection, so popover.ts's onSelectionChanged hook never fires — without
  // this, a card left open into a Reset layout / template load kept showing a now-detached node.
  renderPopover();

  // Grid snap: .flow-world stays 0x0 (an absolute div whose
  // children, .flow-edges included, are all position:absolute — sizing it
  // would move its default transform-origin off 0,0 and desync every
  // pan/zoom/edge-drag/marquee calculation that assumes that origin). The
  // grid itself is drawn on flow-snap-grid's ::before pseudo-element
  // (styles.css), sized far past any plausible node extent instead of to
  // WORLD_W/WORLD_H, so nodes below/left of the old 1800x700 cutoff still
  // have a grid under them. Idempotent across repeated loadGraph calls (Reset layout,
  // template load).
  S.worldEl.classList.add("flow-snap-grid");

  S.nodes = graph.nodes.map((n) => ({ ...n, fields: n.fields.map((f) => ({ ...f })), addons: n.addons?.map((a) => ({ ...a })) }));
  S.edges = graph.edges.map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } }));

  for (const e of S.edges) {
    const pair = buildEdgePath(e);
    S.edgePaths.set(e.id, pair);
    S.edgesEl.appendChild(pair.hit);
    S.edgesEl.appendChild(pair.vis);
  }
  for (const n of S.nodes) {
    const el = buildNode(n);
    S.nodeEls.set(n.id, el);
    observeNode(el);
    S.worldEl.appendChild(el);
  }
}

/** Single creation path for a new node dropped from the `+` palette:
 *  mints an id, adds it to `S.nodes`, builds
 *  and mounts its DOM element. Does not call scheduleGraphSave or select the new
 *  node — the caller (palette.ts) does, after also stamping any
 *  preset-specific fields (model, task, `{k:"preset",...}`).
 *
 *  A caller-supplied `node.id` is validated against the id charset and
 *  against every existing id in `S.nodes` — falling back to minting from
 *  `idBase` on either mismatch, rather than trusting the caller and letting
 *  a bad or colliding id in (the charset/uniqueness
 *  checks run outside the auto-mint path too). */
export function createNode(node: Omit<FlowNode, "id"> & { id?: string }, idBase: string = node.kind): FlowNode {
  const used = new Set(S.nodes.map((nn) => nn.id));
  const id = node.id && isValidId(node.id) && !used.has(node.id) ? node.id : mintId(idBase, used);
  const full: FlowNode = { ...node, id, x: snapCoord(node.x, S.GRID), y: snapCoord(node.y, S.GRID) };
  S.nodes.push(full);
  const el = buildNode(full);
  S.nodeEls.set(full.id, el);
  observeNode(el);
  S.worldEl.appendChild(el);
  scheduleFrame();
  return full;
}
