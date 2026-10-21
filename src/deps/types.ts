// src\deps\types.ts — the dependency catalog's shape and the detect result.
// The catalog is contracts\dependencies.json: Rust reads each entry's `probe` through
// include_str! (src-tauri\src\deps.rs), the frontend reads the copy fields through a JSON
// import (src\deps\state.ts). Ids are the join key between the two and the roster's `requires`.

export type DepProbe =
  /** PATH search for the first matching name, then each env-expanded candidate path.
   *  `minVersion` (`X.Y` or `X.Y.Z`): Rust runs `<exe> --version`; below it or unreadable = missing. */
  | { kind: "exe"; names: string[]; candidates?: string[]; minVersion?: string }
  /** Files relative to the Vidar root; found when the first one exists. */
  | { kind: "vidar"; files: string[] }
  /** A vidar.json key (dotted path) naming an existing file; `fallback` is probed when `key` is unset or blank. */
  | { kind: "config"; key: string; fallback?: string }
  /** A user environment variable, process env first, then HKCU\Environment. Value never returned. */
  | { kind: "env"; name: string }
  /** A launchable Falcon bundle. */
  | { kind: "falcon" };

interface DepInstall {
  winget?: string;
  command?: string;
  url?: string;
  note?: string;
  /** The command that logs in, offered when the row's status carries a `warning` (claude only). */
  login?: string;
}

/** One `usedBy` entry: a plain label, or a label shown only while its module ships in the running
 *  set (modules/registry.ts `moduleListed`). Pack deps keep plain strings (manifest.rs check_dep). */
export type DepUse = string | { label: string; module: string };

export interface DepEntry {
  id: string;
  label: string;
  /** Required deps reopen the Dependencies page at launch while missing. */
  required: boolean;
  usedBy: DepUse[];
  probe: DepProbe;
  install: DepInstall;
  /** `"claude"`: Rust also runs the Claude Code login check on the found exe (sets `warning`). */
  authCheck?: "claude";
  /** Present: the startup update check covers this exe. `package` is the npm package installed next
   *  to it; `native` lets a non-npm `.exe` install update itself (src-tauri deps/updates.rs). */
  update?: { package?: string; native?: boolean };
}

export interface DepCatalog {
  version: number;
  deps: DepEntry[];
}

/** One row of `detect_dependencies`, in catalog order. */
export interface DepStatus {
  id: string;
  found: boolean;
  /** Where it was found (a path), when that means something; never a secret. */
  location?: string;
  /** Why it counts as missing when that is more than "not found" (e.g. riderPath set but no file). */
  detail?: string;
  /** Found but not usable as is: an `authCheck: "claude"` row's "Not Logged In" (src-tauri claude_auth.rs). */
  warning?: string;
}

export interface DepReport {
  /** The Vidar root the `vidar` probes resolved against (`paths::root()`); the setup tab's cwd. */
  root: string;
  deps: DepStatus[];
}
