import type { DepEntry } from "../deps/types";

export type ModuleLevel = "core" | "required-hideable" | "optional";

export interface ModuleDescriptor {
  id: string;
  label: string;
  level: ModuleLevel;
}

export type ModuleKind = "agent" | "content" | "surface" | "capability";
export type SurfacePlacement = "workbench" | "rail";

/** One module declaration as `modules_list` returns it (docs/reference/modules.md § ModuleDecl).
 *  Structurally a CapabilityDecl once `when` is normalised. */
export interface ModuleDecl extends ModuleDescriptor {
  kind: ModuleKind;
  dependsOn?: string[];
  when?: { deps?: string[]; facts?: string[]; config?: string[]; packs?: string[] };
  deps?: DepEntry[];
  agent?: {
    /** Setup Via Agent tries agents by ascending `order` (absent sorts last). */
    setup?: { dep: string; order?: number };
    /** The Flow runner script: one of this module's `owns` files (the scanners check it). */
    flow?: { script: string };
    /** Raw CLI executable basename and individual literal arguments; Rust validates both. */
    launch?: { executable: string; args: string[] };
    gateway?: {
      runner: string;
      baseUrl: string;
      keyVar: string;
      model: string;
      env?: Record<string, string>;
    };
    rows?: ("raw" | "rendered")[];
    art?: { icon: string; tint?: string };
    order?: number;
  };
  surface?: { placement: SurfacePlacement; order?: number; icon?: string };
  /** A missing host denotes a service capability. */
  capability?: { host?: string };
  profiles?: { runner: string; dir: string };
  flowModels?: { id: string; label: string; haiku: string; maxContext: number }[];
  trace?: string[];
  /** Repo-relative files and folders (`a/`) a set without this module cuts. */
  owns?: string[];
}

export type ModuleSource = "core" | "pack";

export interface BrokenModule {
  folder: string;
  reason: string;
}

/** The `modules_list` IPC result. */
export interface ModulesList {
  modules: (ModuleDecl & { source: ModuleSource; folder?: string })[];
  broken: BrokenModule[];
  /** Release set id, present when release-manifest.json's `set` filtered the list (src-tauri modules/set.rs). */
  set?: string;
}

/** Validate a built-in registry while keeping descriptor IDs open to later sources. */
export function defineModuleRegistry<T extends ModuleDescriptor>(
  descriptors: readonly T[],
): readonly T[] {
  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    if (ids.has(descriptor.id)) {
      throw new Error(`Duplicate module ID: ${descriptor.id}`);
    }
    ids.add(descriptor.id);
  }
  return Object.freeze([...descriptors]);
}
