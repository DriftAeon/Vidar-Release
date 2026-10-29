// Headless Flow start wiring; the pure preparation and approval checks live in control-core.
import { initFlowStorage } from "./file-storage";
import { initStore, commitControlGraph } from "./store";
import { initRunsStore } from "./runs-store";
import { heldRunIds, initEngine, reserveControlStart, startRun } from "./engine";
import { S } from "./state";
import { wiredModels } from "./roster";
import { instantiateTemplate, adaptModelsToWired } from "./store-core";
import { validateGraph } from "./validate";
import { autoLayout } from "./layout";
import { approveSnapshot, prepareFlow, saveSnapshot } from "./control-core";
import type { FlowGraph } from "./model";
import type { NodeGrants } from "./permission-mode";

export async function prepareControlFlow(request: unknown): Promise<FlowGraph> {
  await initFlowStorage();
  await initStore();
  await initRunsStore(heldRunIds());
  return prepareFlow(request, {
    templates: S.templates, wiredIds: wiredModels().map((model) => model.id),
    instantiateTemplate, adaptModelsToWired, validateGraph, autoLayout,
    now: () => new Date().toISOString(), newId: () => `graph-${crypto.randomUUID()}`,
  });
}

export async function saveControlFlow(request: unknown): Promise<string> {
  const graph = await prepareControlFlow(request);
  return saveSnapshot(graph, { validateGraph, commit: commitControlGraph });
}

export async function approveControlFlow(snapshot: FlowGraph, grants?: NodeGrants): Promise<string> {
  return approveSnapshot(snapshot, { validateGraph, reserve: reserveControlStart,
    preflight: async () => { await initRunsStore(heldRunIds()); initEngine(); },
    commit: commitControlGraph, start: (graph) => startRun(graph, true, grants).id });
}
