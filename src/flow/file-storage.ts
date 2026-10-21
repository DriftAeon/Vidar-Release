// Flow storage wiring: the app's one
// FileStorage (file-storage-core.ts) over `flow_store_open`/`flow_store_write`
// (src-tauri/src/flow_store.rs). Flow reads nothing from localStorage: the one-time import of
// the old keys is gone, so a fresh install never inherits another install's graphs.
//
// main.ts awaits `initFlowStorage()` beside `initPrefs()` before anything mounts, so store.ts and
// runs-store.ts read a hydrated mirror synchronously.

import { invoke } from "../ipc";
import { FileStorage, type FlowStorageErrorKind } from "./file-storage-core";

const storage = new FileStorage({
  open: () => invoke("flow_store_open"),
  write: (page, seq, entries) => invoke("flow_store_write", { page, seq, entries }),
});

let init: Promise<void> | null = null;

/** Opens the file store. Never rejects. */
export function initFlowStorage(): Promise<void> {
  if (!init) {
    init = hydrate().catch((e) => {
      console.error(`flow: storage init failed: ${e}`);
    });
  }
  return init;
}

async function hydrate(): Promise<void> {
  await storage.init();
}

export function flowStorage(): FileStorage {
  return storage;
}

/** Best effort: the IPC call may not finish during unload. */
export function flushFlowStorage(): Promise<boolean> {
  return storage.flush();
}

/** One subscriber: `save` (a refused batch, with its keys), `unreadable`, `locked` or `lockfailed`
 *  (at init, replayed to a subscriber registered after it). */
export function onFlowStorageError(cb: ((kind: FlowStorageErrorKind, keys: string[], err: unknown) => void) | null): void {
  storage.onError(cb);
}
