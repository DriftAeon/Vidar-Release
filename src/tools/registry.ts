// Toolbar declarations come from the compiled module contract. Factories load only when shown.
import contract from "../../contracts/modules.json" with { type: "json" };
import { defineModuleRegistry, type ModuleDecl, type ModuleDescriptor } from "../modules/types";
import { moduleListed } from "../modules/registry";
import type { Tool } from "../panels/toolbench";

export interface ToolModule extends ModuleDescriptor {
  level: "optional";
  load: () => Promise<() => Tool>;
}

const loaders: Record<string, () => Promise<() => Tool>> = {
  marquee: () => import("./marquee").then(({ marqueeTool }) => marqueeTool),
  eyedropper: () => import("./eyedropper").then(({ eyedropperTool }) => eyedropperTool),
};

export const BUILTIN_TOOL_MODULES: readonly ToolModule[] = defineModuleRegistry(
  (contract.core as ModuleDecl[])
    .filter((entry) => entry.kind === "surface" && entry.surface?.placement === "rail"
      && entry.level === "optional" && Object.hasOwn(loaders, entry.id))
    .sort((a, b) => (a.surface?.order ?? 0) - (b.surface?.order ?? 0))
    .map(({ id, label }) => ({ id, label, level: "optional", load: loaders[id] })),
);

/** Keep registry order and include only active module IDs before any factory is loaded. A tool a
 *  release set does not list (`moduleListed`) is left out whatever `enabled` says. */
export function createToolRegistry(
  enabled: (id: string) => boolean = () => true,
  descriptors: readonly ToolModule[] = BUILTIN_TOOL_MODULES,
): readonly ToolModule[] {
  return defineModuleRegistry(descriptors).filter((descriptor) => moduleListed(descriptor.id) && enabled(descriptor.id));
}
