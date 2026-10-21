// Changes tab IPC: the changes_* commands (src-tauri/src/changes.rs). Every call takes the repo
// root the caller captured at click time, never a fresh read of the focused tab.
import { invoke } from "../ipc";
import type { ChangesCommitResult, ChangesStatus, ChangesSyncResult } from "../ipc";

export type ActVerb = "stage" | "unstage" | "revert";
export type SyncMode = "sync" | "pull" | "push";

export function readStatus(cwd: string): Promise<ChangesStatus> {
  return invoke("changes_status", { cwd });
}

export function act(root: string, verb: ActVerb, paths: string[]): Promise<void> {
  return invoke("changes_act", { cwd: root, verb, paths });
}

export function commit(root: string, message: string, sync: boolean): Promise<ChangesCommitResult> {
  return invoke("changes_commit", { cwd: root, message, sync });
}

export function syncRepo(root: string, mode: SyncMode): Promise<ChangesSyncResult> {
  return invoke("changes_sync", { cwd: root, mode });
}

export function renameBranch(root: string, name: string): Promise<void> {
  return invoke("changes_rename_branch", { cwd: root, name });
}

/** A rejected invoke carries the backend's String error; shown exactly as it came. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
