// Settings > Build: a dev-only page that builds a zip from a set with its modules toggled
// (release_build.rs, tools/release/release-build.ps1). The page exists only when
// release_build_catalog answers, asked once at registration: an install without the release tools
// refuses it ("Build Unavailable: No Release Tools In This Install") and gets no page.
// The run lives in Rust, not in the page: closing Settings leaves it running, and the page reattaches
// through release_build_state (replaying its events) each time it is built.
import { invoke, listen } from "../../ipc";
import { copyText } from "../../clipboard";
import type { ReleaseBuildCatalog, ReleaseBuildEvent, ReleaseBuildResult } from "../../ipc-settings";
import { addSettingRow, registerCategory } from "../registry";
import {
  applyEvent, dimmed, elapsed, emptyRun, flip, includeList, replay, sameSet, setOn, toggles,
  type RunModel, type Toggle,
} from "./state";
import { paintRun, renderBuild, type BuildHandlers, type BuildView, type Mode } from "./view";

export const BUILD_CATEGORY = "build";

let catalog: ReleaseBuildCatalog | null = null;
let list: Toggle[] = [];
let baseId = "";
let on = new Set<string>();
let mode: Mode = "idle";
let run: RunModel = emptyRun();
let startedAt = 0;
let busy: BuildView["busy"] = null;
let error = "";
let errorFrom: BuildView["errorFrom"] = null;
let root: HTMLElement | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
/** The result Done put away: release_build_state keeps the last result until the next start. */
let dismissed = "";

function baseSet() {
  return catalog?.sets.find((s) => s.id === baseId);
}

function view(): BuildView {
  return {
    sets: catalog?.sets ?? [], baseId, list, on, dims: dimmed(on, list), mode, run,
    elapsed: elapsed(startedAt ? Date.now() - startedAt : 0),
    changed: !sameSet(on, setOn(baseSet(), list)), busy, error, errorFrom,
  };
}

function render() {
  if (!root?.isConnected) return;
  renderBuild(root, view(), handlers);
  syncTicker();
}

function syncTicker() {
  const want = mode === "building" && !!root?.isConnected;
  if (want && !ticker) ticker = setInterval(() => (root?.isConnected ? paintRun(root, view()) : syncTicker()), 1000);
  if (!want && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function clearError() {
  error = "";
  errorFrom = null;
}

function finish(result: ReleaseBuildResult) {
  mode = result.ok ? "result" : "failure";
  busy = null;
  clearError();
}

/** One `release-build-event`; a phase or log line seen while idle means a run is under way. */
function onEvent(ev: ReleaseBuildEvent) {
  if (mode === "result" || mode === "failure") {
    if (ev.t === "result") return;
    run = emptyRun();
  }
  const wasBuilding = mode === "building";
  run = applyEvent(run, ev);
  if (ev.t === "result") finish(ev);
  else if (!wasBuilding) {
    mode = "building";
    if (!startedAt) startedAt = Date.now();
  }
  if (!root?.isConnected) return;
  if (mode === "building" && wasBuilding) paintRun(root, view());
  else render();
}

function resultKey(r: ReleaseBuildResult): string {
  return JSON.stringify(r);
}

async function reattach() {
  try {
    const state = await invoke("release_build_state");
    const replayed = replay(state.events);
    if (state.running) {
      // state.phase survives the 200-event cap; the replayed one is the fallback for an older backend
      run = { ...replayed, phase: state.phase ?? replayed.phase ?? run.phase };
      if (mode !== "building") {
        mode = "building";
        if (!startedAt) startedAt = Date.now();
      }
    } else if (state.result && resultKey(state.result) !== dismissed) {
      run = { ...replayed, result: state.result };
      finish(state.result);
    } else if (mode === "building") {
      mode = "idle";
    }
  } catch (e) {
    error = String(e);
    errorFrom = null;
  }
  render();
}

const handlers: BuildHandlers = {
  pick(id) {
    baseId = id;
    on = setOn(baseSet(), list);
    clearError();
    render();
  },
  flip(id) {
    on = flip(on, id, list);
    clearError();
    render();
  },
  reset() {
    on = setOn(baseSet(), list);
    clearError();
    render();
  },
  build() {
    if (busy || !on.size) return;
    busy = "start";
    clearError();
    run = emptyRun();
    dismissed = "";
    startedAt = Date.now();
    render();
    invoke("release_build_start", { base: baseId, include: includeList(on, list) }).then(
      () => {
        busy = null;
        if (mode === "idle") mode = "building";
        render();
      },
      (e) => {
        busy = null;
        startedAt = 0;
        error = String(e);
        errorFrom = "start";
        render();
      },
    );
  },
  cancel() {
    if (busy) return;
    busy = "cancel";
    clearError();
    render();
    invoke("release_build_cancel").then(
      () => { busy = null; render(); },
      (e) => {
        busy = null;
        error = String(e);
        errorFrom = "cancel";
        render();
      },
    );
  },
  done() {
    if (run.result) dismissed = resultKey(run.result);
    mode = "idle";
    run = emptyRun();
    startedAt = 0;
    clearError();
    render();
  },
  openFolder() {
    const path = run.result?.dir || run.result?.zip;
    if (!path) return;
    clearError();
    invoke("open_folder", { path }).catch((e) => {
      error = String(e);
      errorFrom = "result";
      render();
    });
  },
  copyPath() {
    const path = run.result?.zip;
    if (!path) return;
    void copyText(path).then((ok) => {
      error = ok ? "" : "Copy Failed";
      errorFrom = ok ? null : "result";
      render();
    });
  },
};

function mount(): HTMLElement {
  root = document.createElement("div");
  root.className = "module-settings release-build";
  render();
  void reattach();
  return root;
}

let registered = false;

/** Asks for the catalog once; on an answer, adds the Build page and starts following the run. */
export function registerBuildPage(): void {
  if (registered) return;
  registered = true;
  invoke("release_build_catalog").then((c) => {
    if (!c || !Array.isArray(c.sets) || !c.sets.length || !Array.isArray(c.modules)) return;
    catalog = c;
    list = toggles(c);
    baseId = c.sets[0].id;
    on = setOn(c.sets[0], list);
    registerCategory(BUILD_CATEGORY, "Build", "keybinds");
    addSettingRow({
      name: "Build", category: BUILD_CATEGORY, wide: true,
      keywords: () => `release zip set ${list.map((t) => t.label).join(" ")}`,
      control: mount,
    });
    void listen<ReleaseBuildEvent>("release-build-event", (e) => onEvent(e.payload));
  }, () => { /* no release tools: no page */ });
}
