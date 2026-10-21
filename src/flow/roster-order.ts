// Pure runner-group ordering for the Flow roster (roster.ts reads the module registry, so it
// cannot load under `node --test`; this can). The primary agent's runner group leads, because
// the palette fallback and adaptModelsToWired take the first wired row.

/** Stable partition: rows whose runner is `first` come first, the rest keep their order. */
export function leadRunner<T extends { runner: string }>(rows: readonly T[], first: string): T[] {
  return [...rows.filter((r) => r.runner === first), ...rows.filter((r) => r.runner !== first)];
}
