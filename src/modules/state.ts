import type { ModuleDescriptor } from "./types";

export interface ModuleStateInput {
  /** Canonical visibility IDs, for example `bench:tray`. */
  hidden?: readonly string[];
  /** Surface-local IDs in the user's preferred order. */
  order?: readonly string[];
}

export interface ResolvedModule<T extends ModuleDescriptor> {
  descriptor: T;
  visible: boolean;
}

export interface ResolvedModuleState<T extends ModuleDescriptor> {
  modules: readonly ResolvedModule<T>[];
  /** Normalized values to retain if the state is next saved. Unknown IDs stay dormant. */
  hidden: readonly string[];
  order: readonly string[];
}

function firstOccurrences(ids: readonly string[] = []): string[] {
  return [...new Set(ids)];
}

/** Resolve a surface without mutating saved state or mounting any UI.
 *
 * `visibilityId` maps a descriptor to its global visibility ID. Ordering uses
 * descriptor IDs, while visibility uses canonical IDs shared by all surfaces.
 */
export function resolveModuleState<T extends ModuleDescriptor>(
  descriptors: readonly T[],
  saved: ModuleStateInput = {},
  visibilityId: (descriptor: T) => string = (descriptor) => descriptor.id,
): ResolvedModuleState<T> {
  const coreIds = new Set(descriptors.filter((descriptor) => descriptor.level === "core").map(visibilityId));
  const hidden = firstOccurrences(saved.hidden).filter((id) => !coreIds.has(id));
  const hiddenSet = new Set(hidden);
  const order = firstOccurrences(saved.order);
  const rank = new Map(order.map((id, index) => [id, index]));

  // Match the existing row order: unlisted entries follow their nearest listed
  // predecessor in built order, or follow all listed entries if none exists.
  let previous = -1;
  const modules = descriptors.map((descriptor, index) => {
    const knownRank = rank.get(descriptor.id);
    if (knownRank !== undefined) previous = knownRank;
    return {
      descriptor,
      visible: descriptor.level === "core" || !hiddenSet.has(visibilityId(descriptor)),
      rank: knownRank ?? (previous < 0 ? order.length : previous + 0.5),
      index,
    };
  });
  modules.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return {
    modules: modules.map(({ descriptor, visible }) => ({ descriptor, visible })),
    hidden,
    order,
  };
}
