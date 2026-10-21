// The workspace list (vidar.json `locations`): one shared array that the launcher's workspace
// column reads and Settings › Workspaces edits, plus the native folder picker behind both.
import { invoke } from "../ipc";
import { invalidateConfig, loadConfig, resolveDefaultCwd, type Location } from "../config";
import { saveRefusal } from "../settings/save-refusal";

/** Shared by reference: the launcher's flyouts and Resume read it live. Replace through
 *  `setWorkspaces`/`saveWorkspaces`, never by reassigning. */
export const workspaces: Location[] = [];

export function setWorkspaces(list: Location[]) {
  workspaces.splice(0, workspaces.length, ...list);
}

/** Writes the whole list to vidar.json (Rust validates each folder), then adopts it. Refuses
 *  while vidar.json reports a read error: a partial load skipped bad entries, and writing the
 *  filtered list back would delete them (same rule as Settings › Agents / Macros). */
export async function saveWorkspaces(next: Location[]): Promise<void> {
  invalidateConfig();
  const { error } = await loadConfig();
  if (error) throw saveRefusal(error);
  await invoke("save_locations", { locations: next });
  setWorkspaces(next);
}

export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** The Windows folder picker. null = cancelled. With no `start` it opens at the default
 *  folder (resolveDefaultCwd); Rust ignores a start that is not an existing directory. */
export async function pickFolder(start?: string): Promise<string | null> {
  return invoke("pick_folder", { title: "Select Workspace", start: start ?? await resolveDefaultCwd() });
}

/** Select Workspace: pick a folder and save it as a workspace named after the folder
 *  (saved unless that folder is already a workspace, which is reused). null = cancelled. A failed save still returns the
 *  folder, so the launch the user asked for happens; the error is logged. */
export async function pickWorkspace(): Promise<Location | null> {
  const cwd = await pickFolder();
  if (!cwd) return null;
  const known = workspaces.find((w) => w.cwd === cwd);
  if (known) return known; // already saved: reuse it, never add the same folder twice
  const loc = { label: folderName(cwd), cwd };
  try {
    await saveWorkspaces([...workspaces, loc]);
  } catch (e) {
    console.error("save workspace:", e);
  }
  return loc;
}
