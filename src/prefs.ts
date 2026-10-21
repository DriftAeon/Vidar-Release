/* UI state: the app's one PrefsStore (prefs-core.ts) over `vidar-state.json` via
   `read_state` / `patch_state` (src-tauri/src/settings/state.rs). `initPrefs()` runs once at
   boot, before anything reads a pref (main.ts awaits it first); after that `getPref` is
   synchronous and `setPref` updates the cache and debounces the write. Pending writes are
   flushed on pagehide/beforeunload (best effort: the IPC call may not finish during unload).

   This file is the only prefs reader of the page's localStorage: the one-shot import of the
   keys Vidar kept there before the state file existed, removed once the file holds them.
   Flow's keys are not prefs: flow/file-storage.ts copies them into state\flow\ once and
   leaves the localStorage copies in place. */
import { invoke } from "./ipc";
import { PrefsStore, type Json, type PrefKey, type PrefKeys, type PrefSaveOutcome } from "./prefs-core";

const store = new PrefsStore({
  read: () => invoke("read_state"),
  patch: (entries: Record<string, Json>) => invoke("patch_state", { entries }),
});

let init: Promise<void> | null = null;

export function initPrefs(): Promise<void> {
  if (!init) {
    let legacy: Storage | undefined;
    try { legacy = window.localStorage; } catch { /* storage disabled: nothing to import */ }
    init = store.init(legacy);
    const flush = () => { void store.flush(); };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    // No onCloseRequested flush on purpose: a JS listener makes Tauri hold the close and call
    // destroy() (not granted), and main.rs's CloseRequested backstop calls app.exit at once, so
    // the flush could not land anyway. A write inside the debounce window can be lost on close.
  }
  return init;
}

export function getPref<K extends PrefKey>(key: K): PrefKeys[K] | undefined {
  return store.get(key);
}

/** `undefined` deletes the key. False when the state file's size cap refused it (logged). */
export function setPref<K extends PrefKey>(key: K, value: PrefKeys[K] | undefined): boolean {
  return store.set(key, value);
}

/** The cache changes immediately; Saved is valid only after this promise confirms patch_state. */
export function savePrefConfirmed<K extends PrefKey>(key: K, value: PrefKeys[K] | undefined): Promise<PrefSaveOutcome> {
  return store.saveConfirmed(key, value);
}

/** One subscriber for persistence failures: called with the keys of every refused `patch_state`
 *  flush (no retry), and with no keys when vidar-state.json could not be read at init — that
 *  failure is replayed to a subscriber registered after init. The console line is once per key;
 *  `null` unsubscribes. */
export function onPrefsError(cb: ((keys: string[], err: unknown) => void) | null): void {
  store.onError(cb);
}
