// Panel registry: the static panels main.ts mounts at boot, in mount order, each with the
// host element it mounts into and a Dispose that undoes what its mount registers. Sessions and the
// config-gated panels are not here; nothing in a Dispose ends a session or a process. Speak,
// auto-speak and character are capabilities:
// capabilities/registry.ts mounts them lazily.
import { initStatus } from "./status";
import { initInspect } from "./inspect";
import { initCloseLock } from "./closelock";
import { initSwap } from "./swap";
import { initRightbarResize } from "./resize";
import { initRack } from "./rack";
import { initLoadout } from "./loadout";
import { initRailStripe } from "./rail-stripe";
import { moduleOn, onModulesChange } from "../modules/registry";

export type Dispose = () => void;

interface PanelModule {
  id: string;
  mount(host: HTMLElement): Dispose;
}

interface PanelEntry {
  host: () => HTMLElement;
  panel: PanelModule;
}

const byId = (id: string) => () => document.getElementById(id)!;

/** Mounts through an AbortSignal the panel passes to its listeners; Dispose aborts it. */
function signalled(id: string, mount: (host: HTMLElement, signal: AbortSignal) => void): PanelModule {
  return {
    id,
    mount(host) {
      const listeners = new AbortController();
      mount(host, listeners.signal);
      return () => listeners.abort();
    },
  };
}

/** Builds the registry. */
function panels(): PanelEntry[] {
  // Order is fixed by hosts created up front: the rack fills in asynchronously
  // (it awaits its config read before appending). Loadout precedes MCP Servers; both live
  // in the left bar, bottom-anchored above the foot (2026-10-10).
  // Rack module convention: fetch on mount/expand/Refresh, no polling.
  let moduleHosts: { rackHost: HTMLElement; loadoutHost: HTMLElement } | undefined;
  const modulesHost = () => {
    if (!moduleHosts) {
      const modules = document.getElementById("bar-modules")!;
      const rackHost = document.createElement("div");
      const loadoutHost = document.createElement("div");
      modules.append(loadoutHost, rackHost);
      moduleHosts = { rackHost, loadoutHost };
    }
    return moduleHosts;
  };
  return [
    {
      host: byId("status-compact"),
      panel: signalled("status", (host, signal) => {
        void initStatus(
          host,
          document.getElementById("status-expanded")!,
          signal,
        );
      }),
    },
    { host: byId("inspect-btn"), panel: signalled("inspect", (host, signal) => initInspect(host, signal)) },
    { host: byId("close-lock"), panel: signalled("close-lock", (host, signal) => void initCloseLock(host, signal)) },
    // After close-lock: it reads the lock from that host's class (and observes it).
    { host: byId("swap-btn"), panel: signalled("swap", (host, signal) => initSwap(host as HTMLButtonElement, signal)) },
    { host: byId("rightbar-grip"), panel: signalled("rightbar-resize", (host, signal) => initRightbarResize(host, signal)) },
    { host: () => modulesHost().rackHost, panel: signalled("rack", (host, signal) => {
      void initRack(host, { exclude: (s) => s.name === "proxy" }, signal);
    }) },
    { host: () => modulesHost().loadoutHost, panel: signalled("loadout", (host, signal) => initLoadout(host, signal)) },
    // the empty right rail's proxy MCP buttons; hidden by CSS while the full rail is back (rail.css)
    { host: byId("rail-stripe"), panel: signalled("rail-stripe", (host, signal) => initRailStripe(host, signal)) },
  ];
}

/** Mounts static panels and follows Claude's module availability for the rack. */
export function mountPanels(): Dispose {
  const disposers: Dispose[] = [];
  for (const { host, panel } of panels()) {
    if (panel.id === "rack" || panel.id === "rail-stripe") {
      let mountDispose: Dispose | undefined;
      const refresh = () => {
        if (moduleOn("claude") || moduleOn("codex")) {
          mountDispose ??= panel.mount(host());
        } else {
          mountDispose?.();
          mountDispose = undefined;
        }
      };
      refresh();
      const unsubscribe = onModulesChange(refresh);
      disposers.push(() => { unsubscribe(); mountDispose?.(); });
    } else {
      disposers.push(panel.mount(host()));
    }
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch (e) {
        console.error("panel dispose:", e);
      }
    }
  };
}
