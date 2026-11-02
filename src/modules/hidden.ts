// src\modules\hidden.ts — the one write path for `modules.hidden` and the one change notice.
// Kept apart from registry.ts, which pulls in ipc and the dependency state; panels import this one.
import { getPref, setPref } from "../prefs";

/** Tell every module surface that visibility or order changed (they re-read prefs). */
export function notifyModulesChanged(): void {
  document.dispatchEvent(new document.defaultView!.CustomEvent("vidar-modules-change"));
}

/** Add `key` to `modules.hidden` (no-op when already there) and notify when the save took. */
export function hideModule(key: string): void {
  const hidden = getPref("modules.hidden") ?? [];
  if (hidden.includes(key)) return;
  if (setPref("modules.hidden", [...hidden, key])) notifyModulesChanged();
}
