// src\runes\bare\io.ts — binds the Bare flow's BareFlowIo to the bare_* and rules_import_* commands
// (run 2026-10-17-bare-runes-flow, T2b). `bare_layer_set` rejects with a string ending "not saved"; it is
// passed through untouched so the flow's layer line shows it. A library `source` is absolute.
import { invoke as realInvoke, listen as realListen } from "../../ipc";
import type { BareFlowIo } from "./flow";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (event: string, fn: (e: { payload: unknown }) => void) => Promise<() => void>;

export function createBareIo(
  invoke: Invoke = realInvoke as unknown as Invoke,
  listen: Listen = realListen as unknown as Listen,
): BareFlowIo {
  return {
    localSources: (cwd) => invoke("bare_local_sources", { cwd }) as ReturnType<BareFlowIo["localSources"]>,
    actives: (rowKey) => invoke("bare_actives", { rowKey }) as ReturnType<BareFlowIo["actives"]>,
    scan: (path, cwd) => invoke("rules_import_scan", { path, cwd }) as ReturnType<BareFlowIo["scan"]>,
    apply: (a) => invoke("rules_import_apply", { path: a.path, kept: a.kept, rows: a.rows, cwd: a.cwd }) as ReturnType<BareFlowIo["apply"]>,
    layerSet: (a) => invoke("bare_layer_set", { ...a }) as ReturnType<BareFlowIo["layerSet"]>,
    setLayerWrite: (a) => invoke("bare_set_layer_write", { library: a.library, set: a.set, layer: a.layer }),
    generate: (a) => invoke("rules_generate", { ...a }) as ReturnType<BareFlowIo["generate"]>,
    generateCancel: (runId) => invoke("rules_generate_cancel", { runId }),
    generateProgress: (fn) => listen("rules-generate-progress", (e) => fn(e.payload as Parameters<typeof fn>[0])),
    generateToggle: (a) => invoke("rules_generate_toggle", { ...a }) as ReturnType<BareFlowIo["generateToggle"]>,
  };
}
