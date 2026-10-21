// src\onboarding\modules-list.ts — the pure row list behind the onboarding Modules step. No runtime
// imports, so `node --test` loads it directly; step-modules.ts binds the registry and the DOM.

/** Bench surfaces the step offers, in display order (contracts/modules.json ids). */
export const ONBOARDING_MODULE_IDS: readonly string[] = [
  "tray", "doc", "flow", "runelib", "lab", "changes", "unreal", "jira", "notion", "slack",
];

export interface ModuleRowInput { id: string; label: string; level: string }
export interface ModuleListRow {
  /** The bench id (`tray`). */
  key: string;
  /** The Settings row id (`bench:tray`), the key `modules.hidden` and setModuleVisible use. */
  id: string;
  label: string;
}

/** Pure: the rows for the ids the release lists, in step order. An id the registry lacks, or a core one
 *  (never switchable), gets no row. */
export function moduleRows(modules: readonly ModuleRowInput[], listed: (id: string) => boolean): ModuleListRow[] {
  const rows: ModuleListRow[] = [];
  for (const key of ONBOARDING_MODULE_IDS) {
    const m = modules.find((item) => item.id === key);
    if (!m || m.level === "core" || !listed(key)) continue;
    rows.push({ key, id: `bench:${key}`, label: m.label });
  }
  return rows;
}

/** Pure: whether a row reads on, from the saved `modules.hidden` list. */
export function rowOn(row: ModuleListRow, hidden: readonly string[]): boolean {
  return !hidden.includes(row.id);
}
