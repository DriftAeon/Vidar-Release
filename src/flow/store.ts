// Storage wiring: owns S.graphs/activeGraphId/templates and keeps S.nodes/S.edges as the
// working copy of the active graph, backed by the Flow file store (file-storage.ts) through
// store-core.ts's leaf functions.
//
// Wired into panels/flow.ts since the "1-close" slice migrated inspector.ts/nodes.ts/edges.ts
// off the deleted persist.ts's scheduleSave onto this module's. Never seeds MOCK_GRAPH (gone —
// Reset layout reseeds from a starter template instead).

import type { FlowGraph } from "./model";
import { S } from "./state";
import {
  readGraphsEnvelope,
  readTemplatesEnvelope,
  backupInvalidEnvelope,
  saveGraphsEnvelope,
  seedGraphsIfAbsent,
  seedTemplatesIfAbsent,
  reseedStarters,
  deleteGraphFromEnvelope,
  loadGraphsEnvelope,
  STARTERS_REV,
  instantiateTemplate,
  normalizeGraphsEnvelope,
  normalizeLegacyEnvelope,
  stampGraph,
  uniqueGraphName,
  GRAPHS_KEY,
  TEMPLATES_KEY,
  type GraphsEnvelope,
  type StorageLike,
} from "./store-core";
import { RETIRED_STARTER_IDS, RETIRED_TEMPLATE_ALIASES, STARTER_TEMPLATES } from "./templates";
import { flowStorage } from "./file-storage";
import { wiredModels } from "./roster";

let saveTimer: number | undefined;
let initPromise: Promise<void> | null = null;
let commitPromise: Promise<void> = Promise.resolve();
let commitInFlight = false;
let deferredSave = false;

/** One subscriber slot (panels/flow.ts's RUN gate + `.invalid` marking), called synchronously
 *  from `scheduleGraphSave` — the same register-a-callback inversion edges.ts uses for
 *  onSelectionChanged, so store.ts never imports forward into panels/. */
let graphEditedCb: (() => void) | null = null;

export function onGraphEdited(cb: () => void): void {
  graphEditedCb = cb;
}

/** One subscriber slot for a failed `saveGraphsEnvelope` write (quota, private mode, storage
 *  disabled) — panels/flow.ts wires this to the Flow toast (viewport.ts's `showFlowToast`) so a
 *  silent save failure becomes a visible note instead. */
let saveFailedCb: (() => void) | null = null;

export function onSaveFailed(cb: () => void): void {
  saveFailedCb = cb;
}

function now(): string {
  return new Date().toISOString();
}

function notifySafely(label: string, cb: (() => void) | null): void {
  try { cb?.(); } catch (error) { console.error(`[flow] ${label} notification failed:`, error); }
}

function savedActiveId(): string | null {
  return S.draftGraph ? null : S.activeGraphId;
}

/** `saveGraphsEnvelope`'s one call site — every persist reaches storage through here so a
 *  failed write (quota, private mode) surfaces once via `saveFailedCb` instead of at each of
 *  the four call sites separately. */
function save(storage: StorageLike, env: GraphsEnvelope): void {
  if (commitInFlight) { deferredSave = true; return; }
  if (!saveGraphsEnvelope(storage, env)) notifySafely("save failure", saveFailedCb);
}

/** Loads (or first-load seeds) graphs and templates from the Flow file store into `S`, and
 *  points `S.nodes`/`S.edges` at the active graph's working copy. Call once at Flow mount, after
 *  main.ts's `initFlowStorage()` (the store throws before it). */
export function initStore(): Promise<void> {
  if (initPromise) return initPromise;
  const storage = flowStorage();
  const nowStr = now();

  // Present-but-invalid (unparsable, or a `v` this build doesn't handle) is backed up under a
  // `.bak-<stamp>` key before the seed path below overwrites GRAPHS_KEY — an absent key needs no
  // backup, there's nothing to lose.
  const graphsRead = readGraphsEnvelope(storage);
  if (graphsRead.status === "invalid") backupInvalidEnvelope(storage, GRAPHS_KEY, graphsRead.raw, nowStr);
  const rawEnv = graphsRead.status === "ok" ? graphsRead.env : seedGraphsIfAbsent(storage, nowStr);
  // Pre-v1 node/addon kinds (a "Legacy layout" migrated from layout.v1, either just now or by an
  // earlier build) are rewritten to v1 kinds once; the result is not legacy, so later loads no-op.
  // §2 has no note field, so dropped content is recorded here: console.info plus a backup of the
  // stored envelope as it was before this rewrite.
  const legacy = normalizeLegacyEnvelope(normalizeGraphsEnvelope(rawEnv, nowStr));
  const env = legacy.env;
  if (legacy.changed) {
    if (graphsRead.status === "ok") backupInvalidEnvelope(storage, GRAPHS_KEY, graphsRead.raw, nowStr);
    console.info("[flow] legacy graph normalised to v1 kinds; dropped:", legacy.drops);
  }
  S.graphs = env.graphs;
  S.activeGraphId = env.activeGraphId;
  save(storage, env);

  const templatesRead = readTemplatesEnvelope(storage);
  if (templatesRead.status === "invalid") backupInvalidEnvelope(storage, TEMPLATES_KEY, templatesRead.raw, nowStr);
  const templates = templatesRead.status === "ok" ? templatesRead.env.templates : seedTemplatesIfAbsent(storage, STARTER_TEMPLATES);
  S.templates = reseedStarters(storage, templates, STARTER_TEMPLATES, STARTERS_REV, [...Object.keys(RETIRED_TEMPLATE_ALIASES), ...RETIRED_STARTER_IDS]);

  const active = S.graphs.find((g) => g.id === S.activeGraphId);
  S.nodes = active ? active.nodes : [];
  S.edges = active ? active.edges : [];
  initPromise = Promise.resolve();
  return initPromise;
}

/** Save an approved graph without changing the open canvas or publishing it before disk ack. */
export function commitControlGraph(graph: FlowGraph): Promise<() => Promise<void>> {
  const operation = commitPromise.then(async () => {
    await initStore();
    commitInFlight = true;
    const storage = flowStorage();
    try {
      if (!(await storage.flush())) throw new Error("pending writes failed");
      const previous = storage.captureKey(GRAPHS_KEY);
      const env: GraphsEnvelope = { v: 1, activeGraphId: savedActiveId(),
        graphs: [...S.graphs, graph] };
      try {
        storage.setItem(GRAPHS_KEY, JSON.stringify(env));
        if (!(await storage.flush())) throw new Error("flush failed");
      } catch (error) {
        storage.restoreKey(GRAPHS_KEY, previous);
        throw error;
      }
      S.graphs.push(graph);
      notifySafely("graph edit", graphEditedCb);
      return () => {
        const rollback = commitPromise.then(async () => {
          commitInFlight = true;
          try {
            if (!(await storage.flush())) throw new Error("pending writes failed");
            if (previous.value === null) storage.removeItem(GRAPHS_KEY);
            else storage.setItem(GRAPHS_KEY, previous.value);
            if (!(await storage.flush())) throw new Error("rollback flush failed");
            S.graphs = S.graphs.filter((item) => item !== graph);
          } finally {
            commitInFlight = false;
            if (deferredSave) {
              deferredSave = false;
              save(storage, { v: 1, activeGraphId: savedActiveId(), graphs: S.graphs });
            }
          }
        });
        commitPromise = rollback.catch(() => {});
        return rollback;
      };
    } finally {
      commitInFlight = false;
      if (deferredSave) {
        deferredSave = false;
        save(storage, { v: 1, activeGraphId: savedActiveId(), graphs: S.graphs });
      }
    }
  });
  commitPromise = operation.then(() => {}, () => {});
  return operation;
}

/** Writes `S.nodes`/`S.edges` back into the active graph (stamping `updatedAt`) and persists the
 *  whole envelope, synchronously — the body `scheduleGraphSave`'s debounce timer runs, also
 *  callable directly. With no graph open there is nothing to write: the empty state allows no
 *  edits, and minting an Untitled graph here would undo a deleted flow's empty selection. */
function flushGraphSaveNow(): void {
  if (!S.activeGraphId) return;
  const idx = S.graphs.findIndex((g) => g.id === S.activeGraphId);
  if (idx === -1) return;
  const stamped = stampGraph({ id: S.activeGraphId, name: S.graphs[idx].name, nodes: S.nodes, edges: S.edges }, now());
  S.graphs[idx] = stamped;
  save(flowStorage(), { v: 1, activeGraphId: S.activeGraphId, graphs: S.graphs });
}

/** Debounced entry point — same 250ms shape the deleted persist.ts's scheduleSave used. Call after every
 *  mutation that should survive a reload. */
export function scheduleGraphSave(): void {
  // Every graph mutation (node/edge create or delete, drag end, nudge, inspector edit) already
  // funnels through here synchronously after mutating S.nodes/S.edges, so this is the one hook
  // that re-runs validation for all of them — the palette's node creation used to reach no
  // recompute at all except panels/flow.ts's 500ms poll.
  graphEditedCb?.();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    flushGraphSaveNow();
  }, 250);
}

/** Clears any pending debounced save and writes it immediately. Call before switching the active
 *  graph out from under `S.nodes`/`S.edges` — without this, a pending timer fired *after* the
 *  switch and wrote the *new* graph's working copy into the new graph a second time, and the old
 *  graph's not-yet-saved edits (including deletes, which reassign `S.nodes`/`S.edges` in place)
 *  were lost for good. */
export function flushGraphSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  flushGraphSaveNow();
}

/** `flushGraphSave` only when the debounce timer is pending, so a close or reload with nothing
 *  unsaved writes nothing and leaves the active graph's `updatedAt` alone. */
export function flushPendingGraphSave(): void {
  if (saveTimer !== undefined) flushGraphSave();
}

export function cancelPendingGraphSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
}

/** Switches the working copy to another stored graph. Flushes the outgoing graph's pending save
 *  first (see `flushGraphSave`), then persists the switch itself. */
export function setActiveGraph(graph: FlowGraph): void {
  flushGraphSave();
  S.draftGraph = null;
  S.activeGraphId = graph.id;
  // Control-approved graphs remain frozen as the reviewed/saved/run snapshot;
  // the canvas gets a separate working copy when one is later opened for editing.
  S.nodes = Object.isFrozen(graph) ? structuredClone(graph.nodes) : graph.nodes;
  S.edges = Object.isFrozen(graph) ? structuredClone(graph.edges) : graph.edges;
  save(flowStorage(), { v: 1, activeGraphId: S.activeGraphId, graphs: S.graphs });
}

/** The unsaved template instance on the canvas, or `null` when the canvas shows a user graph. */
export function activeDraft(): FlowGraph | null {
  return S.draftGraph && S.draftGraph.id === S.activeGraphId ? S.draftGraph : null;
}

/** Applies a template as an unsaved instance (node ids kept, §7; nodes/edges cloned, so the
 *  template is never touched). Flushes the outgoing graph first. Nothing joins `S.graphs` and the
 *  envelope is not written: the debounced save finds no stored graph under the draft's id and
 *  writes nothing, so edits stay unsaved until `saveDraft`, and a reload returns to the last
 *  stored active graph. */
export function applyTemplateDraft(templateId: string): FlowGraph | null {
  const resolvedId = RETIRED_TEMPLATE_ALIASES[templateId] ?? templateId;
  const template = S.templates.find((t) => t.id === resolvedId);
  if (!template) return null;
  flushGraphSave();
  const draft = instantiateTemplate(template, now(), wiredModels().map((m) => m.id as string));
  S.draftGraph = draft;
  S.activeGraphId = draft.id;
  S.nodes = draft.nodes;
  S.edges = draft.edges;
  return draft;
}

/** Save: moves the active draft into `S.graphs` (the user list) under its own id, so runs
 *  started on the draft stay with it, named `uniqueGraphName` against the stored names, and
 *  persists. `null` when no draft is active. */
export function saveDraft(): FlowGraph | null {
  const draft = activeDraft();
  if (!draft) return null;
  cancelPendingGraphSave();
  const name = uniqueGraphName(draft.name, S.graphs.map((g) => g.name));
  const graph = stampGraph({ id: draft.id, name, nodes: S.nodes, edges: S.edges }, now());
  S.graphs.push(graph);
  S.draftGraph = null;
  S.activeGraphId = graph.id;
  save(flowStorage(), { v: 1, activeGraphId: S.activeGraphId, graphs: S.graphs });
  return graph;
}

/** Delete for a saved user graph (the picker's User list); `false` when refused. Template and
 *  starter ids, retired aliases included, are refused here, not only hidden in the picker. The
 *  envelope is rewritten through the same file-store write as every save. Deleting the graph on
 *  the canvas leaves none open (`S.activeGraphId` null, empty working copy, persisted as null);
 *  the caller clears the canvas. With a template draft on the canvas the draft stays and the
 *  stored active id goes null when it named the deleted graph. Recorded runs are not touched. */
export function deleteGraph(id: string): boolean {
  const protectedIds = [
    ...S.templates.map((t) => t.id),
    ...STARTER_TEMPLATES.map((t) => t.id),
    ...Object.keys(RETIRED_TEMPLATE_ALIASES),
  ];
  if (protectedIds.includes(id) || !S.graphs.some((g) => g.id === id)) return false;
  const storage = flowStorage();
  const draft = activeDraft();
  if (S.activeGraphId === id) cancelPendingGraphSave();
  else flushGraphSave();
  const activeId = draft ? loadGraphsEnvelope(storage)?.activeGraphId ?? null : S.activeGraphId;
  const res = deleteGraphFromEnvelope({ v: 1, activeGraphId: activeId, graphs: S.graphs }, id, protectedIds);
  if (!res.ok) return false;
  S.graphs = res.env.graphs;
  if (!draft && res.activeChanged) {
    S.draftGraph = null;
    S.activeGraphId = null;
    S.nodes = [];
    S.edges = [];
  }
  save(storage, res.env);
  return true;
}

/** True while no graph is open (the open flow was deleted, or a reload found none active): the
 *  canvas shows its empty state and every edit path stays off until New or a template. */
export function noGraphOpen(): boolean {
  return S.activeGraphId === null;
}
