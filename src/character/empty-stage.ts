/** What the Character window offers beside the default stage, decided from the pack list alone. */
export type EmptyStage = "none" | "add" | "not-loaded";

/** `failed`: the list call rejected. A null list that has not failed is still loading (show nothing extra). */
export function emptyStage(list: { packs: readonly unknown[] } | null, failed: boolean): EmptyStage {
  if (failed) return "not-loaded";
  if (!list) return "none";
  return (list.packs?.length ?? 0) === 0 ? "add" : "none";
}
