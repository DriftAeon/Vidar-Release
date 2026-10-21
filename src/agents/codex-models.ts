// The Codex model catalog without a Codex tab: when no `codexModels` is saved yet, ask Codex once per
// launch (`codex_list_models`, src-tauri/src/codex_models.rs: a short-lived app-server on the Bare home)
// and save it in the shape a Codex Rendered tab saves (events.ts `models`). Failure is logged once and
// leaves the pref empty, so the Bare view keeps Import Raw only.
import { invoke } from "../ipc";
import { getPref, setPref } from "../prefs";
import { CodexSettings, codexModelsPref } from "./codex-settings";

let fetched: Promise<void> | null = null;

/** Pure: the raw `model/list` pages mapped through the adapter's own catalog, then the saved shape. */
export function codexModelsFromPages(pages: readonly unknown[]): ReturnType<typeof codexModelsPref> {
  const settings = new CodexSettings();
  for (const page of pages) settings.catalog(page);
  return codexModelsPref(settings.catalog([]));
}

/** Fetches and saves the catalog once per launch, only while none is saved; every caller shares the one run. */
export function ensureCodexModels(): Promise<void> {
  if (getPref("codexModels")?.length) return Promise.resolve();
  fetched ??= (async () => {
    try {
      const models = codexModelsFromPages(await invoke("codex_list_models"));
      // a tab may have saved its catalog while this ran: that one stands
      if (models.length && !getPref("codexModels")?.length) setPref("codexModels", models);
      else if (!models.length) console.warn("codex_list_models: Codex listed no models");
    } catch (e) {
      console.warn("codex_list_models:", e);
    }
  })();
  return fetched;
}

/** Tests only: forget this launch's run. */
export function resetCodexModelsForTest(): void {
  fetched = null;
}
