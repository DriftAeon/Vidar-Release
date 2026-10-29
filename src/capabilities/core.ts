/* Capability core: the pure half of the capability registry. Resolution
   (which capabilities are on for a set of facts), ordering (dependencies before dependents) and
   the serialised mount/dispose diff. No DOM, no ipc, no enums: tests load it under node's type
   stripping. registry.ts wires it to the dependency report, vidar.json and the DOM.

   Contract v1 (contracts/capabilities.json): `{ id, label, when: { deps, packs, config, facts },
   dependsOn, host? }`, plus a top-level `facts` list naming every fact id a `when.facts` may use
   (acquired by capabilities/facts.ts). `region` and `ui` are reserved for plugin UI;
   `when.packs` is filled later. The registry is UI gating, not a security boundary.

   Two module shapes, chosen by the declaration: with a `host`, the module exports
   `mount(host, ctx)` and the host is shown/hidden with it; without one it exports `start(ctx)`
   (a service: no DOM, no hide/show, same stop/provide/use/abort). A provide-only feature gated by
   a Rust fact is a hostless declaration whose `start` only calls ctx.provide.
   A module that does not match its declaration is a mount failure. */

// Type-only import: erased under node's type stripping, so tests still load this file bare.
import type { VidarConfig } from "../config";

export type Dispose = () => void;

export interface CapabilityCtx {
  /** Aborted on dispose; pass it to every listener the mount adds, and drop late async work
   *  (check `signal.aborted` after every await). */
  signal: AbortSignal;
  cfg: VidarConfig;
  provide(id: string, api: unknown): void;
  use<T>(id: string): T | null;
}

/** The frozen module contract (plugin API). `stop` runs only when a diff switches the
 *  capability off, never on pagehide/HMR teardown. */
export type CapabilityModule =
  | { mount(host: HTMLElement, ctx: CapabilityCtx): Dispose; start?: never; stop?(): void }
  | { start(ctx: CapabilityCtx): Dispose; mount?: never; stop?(): void };

interface CapabilityWhen {
  /** Dependency ids (contracts/dependencies.json) that must be found. */
  deps?: string[];
  /** Pack ids that must be installed. */
  packs?: string[];
  /** vidar.json keys that must be set (truthy). */
  config?: string[];
  /** Named non-dependency facts that must hold; ids from the contract's top-level `facts`.
   *  They fail closed: absent until capabilities/facts.ts proves them. */
  facts?: string[];
}

export interface CapabilityDecl {
  id: string;
  label: string;
  when: CapabilityWhen;
  dependsOn?: string[];
  /** Element id: un-hidden while on, hidden while off, and the mount's host. Absent: a
   *  service capability whose module exports `start(ctx)`. */
  host?: string;
}

export interface Facts {
  /** Dependency id -> found. null = detection failed or timed out: every dependency reads as
   *  found (fail open). An id missing from the report also reads as found, like isAvailable. */
  deps: ReadonlyMap<string, boolean> | null;
  packs: ReadonlySet<string>;
  config: Readonly<Record<string, unknown>>;
  facts: ReadonlySet<string>;
  /** The vidar.json `capabilities` overlay's off entries (it can only switch things off). */
  off: ReadonlySet<string>;
}

/** Dependencies first, otherwise declaration order. Throws on a duplicate id, an unknown
 *  dependsOn, a dependency id not in `depIds` or a fact id not in `factIds` (each when given),
 *  or a cycle. */
export function order(
  decls: readonly CapabilityDecl[],
  depIds?: ReadonlySet<string>,
  factIds?: ReadonlySet<string>,
): CapabilityDecl[] {
  const byId = new Map<string, CapabilityDecl>();
  for (const d of decls) {
    if (byId.has(d.id)) throw new Error(`capability "${d.id}" is declared twice`);
    byId.set(d.id, d);
  }
  for (const d of decls) {
    for (const dep of d.dependsOn ?? []) {
      if (!byId.has(dep)) throw new Error(`capability "${d.id}" depends on unknown capability "${dep}"`);
    }
    if (depIds) {
      for (const dep of d.when.deps ?? []) {
        if (!depIds.has(dep)) throw new Error(`capability "${d.id}" needs unknown dependency "${dep}"`);
      }
    }
    if (factIds) {
      for (const f of d.when.facts ?? []) {
        if (!factIds.has(f)) throw new Error(`capability "${d.id}" needs unknown fact "${f}"`);
      }
    }
  }
  const out: CapabilityDecl[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (d: CapabilityDecl) => {
    if (done.has(d.id)) return;
    if (visiting.has(d.id)) throw new Error(`capability cycle through "${d.id}"`);
    visiting.add(d.id);
    for (const dep of d.dependsOn ?? []) visit(byId.get(dep)!);
    visiting.delete(d.id);
    done.add(d.id);
    out.push(d);
  };
  for (const d of decls) visit(d);
  return out;
}

/** The ids that are on, with the dependsOn closure: a capability is off when any capability it
 *  depends on is off. `ordered` must come from order(). */
export function resolve(ordered: readonly CapabilityDecl[], facts: Facts): Set<string> {
  const on = new Set<string>();
  const found = (dep: string) => facts.deps === null || facts.deps.get(dep) !== false;
  for (const d of ordered) {
    if (facts.off.has(d.id)) continue;
    const w = d.when;
    if (!(w.deps ?? []).every(found)) continue;
    if (!(w.packs ?? []).every((p) => facts.packs.has(p))) continue;
    if (!(w.config ?? []).every((k) => !!facts.config[k])) continue;
    if (!(w.facts ?? []).every((f) => facts.facts.has(f))) continue;
    if (!(d.dependsOn ?? []).every((dep) => on.has(dep))) continue;
    on.add(d.id);
  }
  return on;
}

export interface Lifecycle<M> {
  /** Loads the capability's code; nothing is on screen yet. */
  load(id: string): Promise<M>;
  /** Mounts synchronously into the host; a throw leaves it unmounted. */
  mount(id: string, mod: M): void;
  /** `switchedOff`: true when a diff turned it off (the stop hook runs), false on teardown
   *  (pagehide/HMR), which never ends sidecars. */
  dispose(id: string, switchedOff: boolean): void;
  /** Launch stop: called once per id, at the end of the first completed step in which
   *  the id is ready, when that step left it unmounted (switched off, gated out, or a failed
   *  load/mount). Dependents first. Never from a later step or from disposeAll. */
  offAtStart?(id: string): void;
}

/** One diff's input, read together so `ready` matches the facts `want` was resolved from.
 *  `ready`: ids whose settle gate has opened, on or off (the launch stop's trigger). */
interface Target {
  want: ReadonlySet<string>;
  ready: ReadonlySet<string>;
}

export interface Applier {
  /** Queues one diff. The target is evaluated when the diff runs, not when it is queued, so a
   *  burst of Refreshes converges on the latest facts and never double-mounts. */
  apply(target: () => Target | Promise<Target>): Promise<void>;
  /** Disposes everything in reverse mount order; queued and in-flight diffs mount nothing after. */
  disposeAll(): void;
}

/** Diffs are serialised through one promise chain: dependents dispose before what they depend on
 *  and mount after it. A capability whose dependency failed to load is skipped. */
export function createApplier<M>(ordered: readonly CapabilityDecl[], life: Lifecycle<M>): Applier {
  const mounted: string[] = [];
  /** Ids the launch-stop pass has already judged (ready in a completed step). */
  const seen = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const disposeOne = (id: string, switchedOff: boolean) => {
    try {
      life.dispose(id, switchedOff);
    } catch (e) {
      console.error(`capability ${id} dispose:`, e);
    }
  };

  const step = async ({ want, ready }: Target) => {
    const drop = new Set<string>();
    for (const id of mounted) {
      const deps = ordered.find((d) => d.id === id)?.dependsOn ?? [];
      if (!want.has(id) || deps.some((dep) => drop.has(dep))) drop.add(id);
    }
    for (let i = mounted.length - 1; i >= 0; i--) {
      const id = mounted[i];
      if (!drop.has(id)) continue;
      mounted.splice(i, 1);
      disposeOne(id, true);
    }
    for (const d of ordered) {
      if (closed) return;
      if (!want.has(d.id) || mounted.includes(d.id)) continue;
      if (!(d.dependsOn ?? []).every((dep) => mounted.includes(dep))) continue;
      let mod: M;
      try {
        mod = await life.load(d.id);
      } catch (e) {
        console.error(`capability ${d.id} load:`, e);
        continue;
      }
      if (closed) return;
      try {
        life.mount(d.id, mod);
        mounted.push(d.id);
      } catch (e) {
        console.error(`capability ${d.id} mount:`, e);
      }
    }
    if (closed) return;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const id = ordered[i].id;
      if (!ready.has(id) || seen.has(id)) continue;
      seen.add(id);
      if (mounted.includes(id)) continue;
      try {
        life.offAtStart?.(id);
      } catch (e) {
        console.error(`capability ${id} launch stop:`, e);
      }
    }
  };

  return {
    apply(target) {
      queue = queue.then(async () => {
        if (closed) return;
        try {
          await step(await target());
        } catch (e) {
          console.error("capability diff:", e);
        }
      });
      return queue;
    },
    disposeAll() {
      if (closed) return;
      closed = true;
      while (mounted.length) disposeOne(mounted.pop()!, false);
    },
  };
}
