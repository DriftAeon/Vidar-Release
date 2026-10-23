// Per-graph canvas pan/zoom. Pure: no DOM, no ipc; the storage is injected (viewport.ts passes
// the Flow file store). One key holds every graph's last view, written debounced (never per pan
// frame), so the position survives a reload and a swap. Authority for the key: the Flow store
// (`vidar.flow.*` files), never localStorage.

import type { StorageLike } from "./store-core";

export const VIEWPORTS_KEY = "vidar.flow.viewports.v1";
export const VIEWPORT_WRITE_MS = 400;
const MAX_ENTRIES = 200;

export type Viewport = { panX: number; panY: number; scale: number };

export interface ViewportMemory {
  /** The graph's saved view, or `null` when it has none (the caller applies the default). */
  get(id: string): Viewport | null;
  set(id: string, vp: Viewport): void;
  /** Drops a deleted graph's view so a later graph never inherits it. */
  forget(id: string): void;
  /** Writes now if dirty. */
  flush(): void;
}

function valid(v: unknown): v is Viewport {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return [o.panX, o.panY, o.scale].every((n) => typeof n === "number" && Number.isFinite(n)) && (o.scale as number) > 0;
}

function parse(raw: string | null): Map<string, Viewport> {
  const out = new Map<string, Viewport>();
  if (!raw) return out;
  try {
    const obj = JSON.parse(raw) as { v?: unknown; views?: Record<string, unknown> };
    if (obj?.v !== 1 || !obj.views || typeof obj.views !== "object") return out;
    for (const [id, vp] of Object.entries(obj.views)) {
      if (valid(vp)) out.set(id, { panX: vp.panX, panY: vp.panY, scale: vp.scale });
    }
  } catch {
    /* unreadable: start empty, the next write replaces it */
  }
  return out;
}

export function createViewportMemory(storage: () => StorageLike): ViewportMemory {
  let views: Map<string, Viewport> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  const load = (): Map<string, Viewport> => {
    if (!views) {
      let raw: string | null = null;
      try {
        raw = storage().getItem(VIEWPORTS_KEY);
      } catch {
        raw = null;
      }
      views = parse(raw);
    }
    return views;
  };

  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!dirty || !views) return;
    dirty = false;
    // Oldest entries (insertion order) go first past the cap.
    while (views.size > MAX_ENTRIES) views.delete(views.keys().next().value as string);
    try {
      storage().setItem(VIEWPORTS_KEY, JSON.stringify({ v: 1, views: Object.fromEntries(views) }));
    } catch {
      /* best effort: a refused write must not break panning */
    }
  };

  const schedule = (): void => {
    dirty = true;
    if (timer === undefined) timer = setTimeout(flush, VIEWPORT_WRITE_MS);
  };

  return {
    get(id) {
      const vp = load().get(id);
      return vp ? { ...vp } : null;
    },
    set(id, vp) {
      const m = load();
      const prev = m.get(id);
      if (prev && prev.panX === vp.panX && prev.panY === vp.panY && prev.scale === vp.scale) return;
      m.delete(id);
      m.set(id, { panX: vp.panX, panY: vp.panY, scale: vp.scale });
      schedule();
    },
    forget(id) {
      if (load().delete(id)) schedule();
    },
    flush,
  };
}
