// src\launcher\vidar-path.ts — one concern: the `{vidar}` token in a launcher row's cwd (board K6).
// A row that must sit inside the Vidar folder (Astra: bridge\display) writes `{vidar}\...` instead
// of an absolute path, so the row works wherever Vidar is unpacked. The root is the deps report's
// `root` (paths::root() in Rust, src-tauri\src\deps.rs), the same value the setup tab uses as cwd.
// Only a LEADING token in a cwd is expanded; args are never touched (a vendor row's `{vidarRoot}`
// in args reached `claude` unexpanded and opened the tab unfenced — args use $env:VIDAR_ROOT,
// which pwsh expands and spawn_pty sets).
import { depsError, depsReport, loadDeps } from "../deps/state";

const VIDAR_TOKEN = "{vidar}";

function hasVidarToken(s: string | undefined): boolean {
  return !!s && s.startsWith(VIDAR_TOKEN);
}

/** Pure: a leading `{vidar}` becomes `root`; anything else is returned unchanged. */
function expandVidarPath(s: string, root: string): string {
  if (!hasVidarToken(s)) return s;
  return root.replace(/[\\/]+$/, "") + s.slice(VIDAR_TOKEN.length);
}

/** For display only (tooltips): expanded when a report is in, raw otherwise. */
export function showVidarPath(s: string): string {
  const root = depsReport()?.root;
  return root ? expandVidarPath(s, root) : s;
}

/** The cwd a launch should use. No token: returned as is. With a token: the report's root, running
 *  detection when there is no report yet and retrying it once (a failed run leaves the report
 *  null until the next one). Rejects with "Vidar Folder Unknown" rather than launching elsewhere. */
export async function resolveVidarCwd(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined || !hasVidarToken(cwd)) return cwd;
  const root = depsReport()?.root ?? (await loadDeps())?.root ?? (await loadDeps())?.root;
  if (!root) {
    const why = depsError();
    throw new Error(why ? `Vidar Folder Unknown: ${why}` : "Vidar Folder Unknown");
  }
  return expandVidarPath(cwd, root);
}
