// Binds source discovery, item import and Generate to the Runes view.
import { invoke as realInvoke, listen as realListen } from "../../ipc";
import type { BareFlowIo } from "./flow";


type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (event: string, fn: (e: { payload: unknown }) => void) => Promise<() => void>;

export function createBareIo(
  invoke: Invoke = realInvoke as unknown as Invoke,
  listen: Listen = realListen as unknown as Listen,
): BareFlowIo {
  return {
    kitCreate: (a) => invoke("bare_kit_create", a) as ReturnType<NonNullable<BareFlowIo["kitCreate"]>>,
    kitItemCreate: (a) => invoke("bare_kit_item_create", a),
    localSources: (cwd) => invoke("bare_local_sources", { cwd }) as ReturnType<BareFlowIo["localSources"]>,
    itemsImport: (a) => invoke("bare_items_import", a) as ReturnType<BareFlowIo["itemsImport"]>,
    moduleBundles: () => invoke("bare_module_bundles") as ReturnType<NonNullable<BareFlowIo["moduleBundles"]>>,
    readText: (path) => (invoke("read_document", { path }) as Promise<{ text: string }>).then((d) => d.text),
    generate: (a) => invoke("rules_generate", { ...a }) as ReturnType<BareFlowIo["generate"]>,
    generateCancel: (runId) => invoke("rules_generate_cancel", { runId }),
    generateProgress: (fn) => listen("rules-generate-progress", (e) => fn(e.payload as Parameters<typeof fn>[0])),
  };
}
