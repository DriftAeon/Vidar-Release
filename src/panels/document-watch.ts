// Disk watcher for the open Document: updated (mtime differs from the LOADED
// one), gone (None), or unchanged. The view hands in its state through `host`.

import { invoke } from "../ipc";

export interface WatchedDoc { path: string; mtimeMs: number; conflict: boolean }

export interface WatchHost<D extends WatchedDoc> {
  gen: () => number;
  doc: () => D | null;
  isDirty: () => boolean;
  autoBlocked: () => boolean;
  setReloadStale: (on: boolean) => void;
  updateSave: () => void;
  setStatus: (text: string) => void;
  reload: (automatic: boolean, stableMtime: number) => Promise<void>;
}

const STAT_MS = 2000;

export function createWatcher<D extends WatchedDoc>(host: WatchHost<D>) {
  let statTimer: number | undefined;
  function stop() {
    if (statTimer !== undefined) { window.clearInterval(statTimer); statTimer = undefined; }
  }
  function start() {
    stop();
    const gen = host.gen();
    let observed: number | null = null;
    let busy = false;
    statTimer = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
      const d = host.doc();
      if (!d || gen !== host.gen()) return stop();
      let m: number | null;
      try { m = await invoke("stat_document", { path: d.path }); } catch { return; }
      if (gen !== host.gen() || host.doc() !== d) return;
      if (m === null) { observed = null; d.conflict = true; host.updateSave(); host.setStatus("file gone — showing the last loaded copy"); return; }
      if (m !== d.mtimeMs) {
        host.setReloadStale(true);
        if (host.isDirty()) { d.conflict = true; host.updateSave(); host.setStatus("changed on disk — reload before saving"); }
        if (m === observed && !host.autoBlocked()) await host.reload(true, m);
      }
      else host.setReloadStale(false);
      observed = m;
      } finally { busy = false; }
    }, STAT_MS);
  }
  return { start, stop };
}
