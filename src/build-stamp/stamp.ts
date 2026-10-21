// The running exe's build stamp, read once from files beside it by the Rust `build_stamp` command
// (src-tauri/src/build_stamp.rs). Kept out of the bundle so dist/assets stays byte-stable across builds.
import { invoke, type CommandRet } from "../ipc";

// local: true for <exe>.head from a local release build, false for a release zip's manifest.
export type BuildStamp = NonNullable<CommandRet<"build_stamp">>;

export const RELEASES_URL = "https://github.com/DriftAeon/Vidar-Release/releases/latest";

let pending: Promise<BuildStamp | null> | null = null;

export function loadBuildStamp(): Promise<BuildStamp | null> {
  pending ??= invoke("build_stamp").catch(() => null);
  return pending;
}
