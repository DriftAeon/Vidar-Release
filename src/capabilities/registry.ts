/* Capability registry: the one lookup core
   uses to find gated features, and their DOM lifecycle. Declarations come from
   the loaded module registry; facts (dependency report, vidar.json `capabilities` off overlay,
   named facts) come from facts.ts, the only module that acquires them. Each capability's code sits
   in capabilities/mounts/<id>.ts and is loaded lazily, so an off capability requests no chunk.
   Core imports no capability code statically (module-boundaries.md, "Pack seam").

   Module contract (frozen; it becomes plugin API; types in core.ts): a declaration with a host
   loads `mount(host, ctx): Dispose`, one without loads `start(ctx): Dispose`; optional `stop()`.
   For a host, the registry snapshots `host.childNodes` before mount and restores them after
   dispose, so a re-mount never duplicates DOM; the host is un-hidden while on and hidden with an
   inline `display: none` while off (`[hidden]` loses to the bar's `display: flex` rules). `stop`
   runs only when a diff switches the capability off (speak: speak_off); pagehide/HMR teardown
   never ends sidecars. Launch stop: once per id, when its gate opens and the diff leaves it
   unmounted, `stops/<id>.ts` (if any) runs, so a sidecar left by an earlier session ends even
   though nothing was mounted to switch off. `ctx.provide(id, api)` is withdrawn on dispose; `use(id)` reads it, also
   from non-capability code (voice-map, the tab menu), and is null while the provider is off. A
   mount must drop late async work (promise callbacks, in-flight IPC results) once `ctx.signal`
   aborts.

   Each capability waits only on the facts.settle() sources it declares (detection for
   when.deps, a fact's probe for when.facts, plus its dependsOn's waits), each bounded by
   DETECT_DEADLINE_MS; it stays out of every diff until then (that diff reads the latest facts
   anyway). After it, each change re-diffs: a dependency report, a named fact, or a config re-read. Config applies on restart or the next
   settings write (`settings-changed`); `reloadConfig` has no caller. UI gating only: the IPC
   commands behind a capability stay registered. */
import { CATALOG } from "../deps/state";
import type { VidarConfig } from "../config";
import { moduleViews } from "../modules/registry";
import {
  createApplier, order, resolve,
  type CapabilityCtx, type CapabilityDecl, type CapabilityModule, type Dispose,
} from "./core";
import { FACT_IDS, onFactsChange, settle, snapshot } from "./facts";

export type { CapabilityCtx,  Dispose } from "./core";

/** Past the per-probe --version bound (3 s), so a slow detect still lands in the first diff. */
const DETECT_DEADLINE_MS = 8_000;

const loaders = import.meta.glob<CapabilityModule>("./mounts/*.ts");
/** Launch stops, opt-in by file: stops/<id>.ts exports `stop()`, and mounts/<id>.ts
 *  re-exports it so a live switch-off runs the same body. Its own chunk, so an off capability
 *  still loads no UI code. */
const stops = import.meta.glob<{ stop(): void | Promise<void> }>("./stops/*.ts");

const provided = new Map<string, unknown>();

/** The API a mounted capability provided under `id`, or null while it is off or not mounted. */
export function use<T>(id: string): T | null {
  return (provided.get(id) as T | undefined) ?? null;
}

interface Live {
  /** null for a service capability (start). */
  host: HTMLElement | null;
  snapshot: Node[];
  controller: AbortController;
  dispose: Dispose;
  mod: CapabilityModule;
  provides: string[];
}

function setShown(host: HTMLElement, on: boolean): void {
  host.style.display = on ? "" : "none";
  host.toggleAttribute("data-off", !on); // CSS keys layout off absence here (layout.css #character[data-off])
}

/** Starts gating: resolves after the first settle (or the deadline), then re-diffs on every fact
 *  change. Returns immediately; core UI never waits on it. */
export function mountCapabilities(initial: VidarConfig): Dispose {
  // Ordered here, not at import: pack-contributed catalog ids land when loadModules() settles,
  // which main.ts awaits before this call, so a pack dep id is not an "unknown dependency".
  // dependsOn may name a non-capability module (a pack capability may need the claude agent pack): the
  // registry already dropped the row when that module is absent, so only capability ids order it.
  const capViews = moduleViews().filter((view) => view.row.kind === "capability" && !view.reason);
  const capIds = new Set(capViews.map((view) => view.row.id));
  const DECLS: CapabilityDecl[] = order(
    capViews
      .map(({ row }) => ({
        id: row.id,
        label: row.label,
        when: row.when ?? {},
        dependsOn: row.dependsOn?.filter((dep) => capIds.has(dep)),
        host: row.capability?.host,
      })),
    new Set(CATALOG.deps.map((d) => d.id)),
    FACT_IDS,
  );
  let cfg = initial;
  const live = new Map<string, Live>();

  const applier = createApplier<CapabilityModule>(DECLS, {
    async load(id) {
      const loader = loaders[`./mounts/${id}.ts`];
      if (!loader) throw new Error(`no mount file for capability "${id}"`);
      return loader();
    },
    mount(id, mod) {
      const decl = DECLS.find((d) => d.id === id)!;
      const host = decl.host === undefined ? null : document.getElementById(decl.host);
      if (decl.host !== undefined && !host) throw new Error(`capability "${id}": no host #${decl.host}`);
      const entry = host ? mod.mount : mod.start;
      if (typeof entry !== "function") {
        throw new Error(`capability "${id}": module must export ${host ? "mount(host, ctx)" : "start(ctx)"}`);
      }
      const snapshot = host ? [...host.childNodes] : [];
      const controller = new AbortController();
      const provides: string[] = [];
      const ctx: CapabilityCtx = {
        signal: controller.signal,
        cfg,
        provide(pid, api) {
          provided.set(pid, api);
          provides.push(pid);
        },
        use,
      };
      let dispose: Dispose;
      try {
        dispose = host ? mod.mount!(host, ctx) : mod.start!(ctx);
      } catch (e) {
        controller.abort();
        for (const pid of provides) provided.delete(pid);
        host?.replaceChildren(...snapshot);
        throw e;
      }
      live.set(id, { host, snapshot, controller, dispose, mod, provides });
      if (host) setShown(host, true);
    },
    dispose(id, switchedOff) {
      const m = live.get(id);
      if (!m) return;
      live.delete(id);
      if (switchedOff) {
        try {
          m.mod.stop?.();
        } catch (e) {
          console.error(`capability ${id} stop:`, e);
        }
      }
      m.controller.abort();
      try {
        m.dispose();
      } finally {
        for (const pid of m.provides) provided.delete(pid);
        if (m.host) {
          m.host.replaceChildren(...m.snapshot);
          setShown(m.host, false);
        }
      }
    },
    offAtStart(id) {
      const loader = stops[`./stops/${id}.ts`];
      if (!loader) return;
      void loader()
        .then((mod) => mod.stop())
        .catch((e: unknown) => console.error(`capability ${id} launch stop:`, e));
    },
  });

  // Per-capability gate: a capability joins a diff only once the
  // sources it declares (when.deps -> detection, when.facts -> that fact's probe) and the gates
  // of what it dependsOn have settled or hit the deadline. Until then it is left out of `want`,
  // so a change before its wait (a config write, the first character list) cannot diff it with
  // no deps report, fail open and flash speak at boot. `ready` is closed under dependsOn.
  const ready = new Set<string>();

  const diff = () =>
    applier.apply(async () => {
      const now = await snapshot();
      cfg = now.cfg;
      const on = resolve(DECLS, now.facts);
      // `ready` is every settled gate, on or off: an overlay-off id is ready and not in `want`,
      // which is exactly what the launch stop fires on. Copied so it matches this `want`.
      return { want: new Set([...on].filter((id) => ready.has(id))), ready: new Set(ready) };
    });

  let disposed = false;
  const unsubscribe = onFactsChange(() => { if (ready.size && !disposed) void diff(); });

  const sources = settle(DETECT_DEADLINE_MS);
  const gates = new Map<string, Promise<void>>();
  for (const d of DECLS) {
    const waits: Promise<void>[] = [];
    if (d.when.deps?.length) waits.push(sources.deps);
    for (const f of d.when.facts ?? []) waits.push(sources.facts.get(f) ?? Promise.resolve());
    for (const dep of d.dependsOn ?? []) waits.push(gates.get(dep)!);
    const gate = Promise.all(waits).then(() => {});
    gates.set(d.id, gate);
    // Never rejects: every wait is bounded() (facts.ts), Promise.resolve() or another gate.
    void gate.then(() => {
      if (disposed) return;
      ready.add(d.id);
      void diff();
    });
  }

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    applier.disposeAll();
  };
}
