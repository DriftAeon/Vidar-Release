/* The bottom-bar settings slice of the typed command map (ipc.ts `Commands` extends it): the named
   switches (settings/switches.rs) and the
   Swap button's pending check and worker (swap_button.rs).
   Types only, like ipc-voice.ts: ipc.ts stays the one file that imports @tauri-apps/api, and the
   host tags stay in ipc-hosts.ts's COMMAND_HOSTS. Split out of ipc.ts for the module-size line. */
import type { Cmd } from "./ipc";

/** pending.ps1's vidar line (swap_button.rs `VidarPending`); `ms` is the script's wall time. */
export interface SwapPending { build: boolean; swap: boolean; running: boolean; lock: boolean; inTab: boolean; ms: number }

/** runtime\bridge\swap-button.json as swap_button.rs reads it; `running` = live worker mid-run. */
export interface SwapState { phase: string | null; error: string | null; pid: number | null; running: boolean; dryRun: boolean; atMs: number | null }

/** release-build.ps1 -List: a build set and its include (`["*"]` = every module). */
export interface ReleaseBuildSet { id: string; label: string; include: string[]; personal: boolean }
/** release-build.ps1 -List: one module a set can carry; core modules ship in every set. */
export interface ReleaseBuildModule { id: string; label: string; kind: string; level: string; dependsOn: string[] }
export interface ReleaseBuildCatalog { sets: ReleaseBuildSet[]; modules: ReleaseBuildModule[] }

export type ReleaseBuildPhase = "check" | "build" | "zip" | "trace" | "done";
/** The wrapper's last line, or release_build.rs's stand-in when it exited without one
 *  (`cancelled: true`, or `error: "Build Failed"`). `ok` with `trace: "fail"` is a finished zip. */
export interface ReleaseBuildResult {
  t: "result"; ok: boolean;
  zip?: string; dir?: string; sizeMb?: number; trace?: "pass" | "fail"; gapHigh?: number;
  dropped?: string[]; built?: boolean; dryRun?: boolean; personal?: boolean;
  phase?: ReleaseBuildPhase; error?: string; cancelled?: boolean;
}
/** One `release-build-event` payload: one protocol line of release-build.ps1. */
export type ReleaseBuildEvent =
  | { t: "phase"; phase: ReleaseBuildPhase }
  | { t: "log"; line: string }
  | ReleaseBuildResult;

/** release_build.rs `BuildState`: the last 200 events, the last result line, and the last phase seen
 *  (kept apart from the capped events; absent before the W2b backend, read as null). */
export interface ReleaseBuildState {
  running: boolean; phase?: ReleaseBuildPhase | null; events: ReleaseBuildEvent[]; result: ReleaseBuildResult | null;
}

export interface SettingsCommands {
  read_switch: Cmd<{ name: string }, boolean>;
  set_switch: Cmd<{ name: string; on: boolean }, boolean>;
  // bottom-bar Swap button (swap_button.rs)
  swap_pending: Cmd<undefined, SwapPending>;
  swap_state: Cmd<undefined, SwapState>;
  swap_start: Cmd<undefined, number>;
  // Settings > Build page (release_build.rs); events are release-build.ps1's JSON lines
  release_build_catalog: Cmd<undefined, ReleaseBuildCatalog>;
  release_build_start: Cmd<{ base: string; include: string[] }, null>;
  release_build_cancel: Cmd<undefined, null>;
  release_build_state: Cmd<undefined, ReleaseBuildState>;
}
