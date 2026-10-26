// src\launcher\reopen-workspace.ts — the refused Codex tab's Select Workspace… (a home-folder refusal,
// codex_cwd.rs): pick a folder, open a tab of the same agent, body and Bare profile there, close the
// refused one. Also the trust card's Refresh: the same tab again in its own folder (worktree and Refresh carry the tab's rune sets). main.ts binds both
// into the rendered body (panels/sessions/rendered-body.ts).
import { invoke } from "../ipc";
import type { TerminalSession } from "../panels/sessions/types";
import { closeSession } from "../panels/sessions";
import { agentKind } from "./agent-kind";
import { shownRoots, shownVariants, spawnFrom } from "./roster";
import { folderName, pickWorkspace } from "./workspaces";

/** The tab's launcher row: the Bare row by its key, else the plain Rendered row of its agent (the Bare
 *  Rendered row when the plain rows are off). */
function rowOf(s: TerminalSession) {
  const art = s.button.dataset.art;
  const rows = shownRoots().flatMap((r) => [r, ...shownVariants(r)]).filter((x) => agentKind(x.id) === s.agent && x.body === "rendered" && !x.role);
  const ofArt = (x: { id: string }) => !art || x.id === art;
  // a plain tab keeps its plain Rendered row while it is shown, else it falls back to the Bare one
  const row = s.rowKey ? rows.find((x) => x.key === s.rowKey) : rows.find((x) => !x.profile && ofArt(x)) ?? rows.find((x) => x.profile && ofArt(x));
  if (!row) throw new Error("No Launcher Row For This Tab");
  return row;
}

/** Cancel resolves without doing anything; a failed spawn rejects with its message and keeps the tab. */
export async function reopenInWorkspace(s: TerminalSession): Promise<void> {
  const row = rowOf(s);
  const loc = await pickWorkspace();
  if (!loc) return;
  await spawnFrom({ ...row, cwd: undefined }, loc);
  closeSession(s.id);
}

/** The Vidar-folder refusal card's Open in Worktree: a git worktree of Vidar at HEAD, the same row
 *  opened there, this tab closed. A failed worktree or spawn rejects and keeps the tab. */
export async function reopenInWorktree(s: TerminalSession): Promise<void> {
  const row = rowOf(s);
  const path = await invoke("vidar_worktree_open");
  await spawnFrom({ ...row, cwd: undefined }, { label: folderName(path), cwd: path }, undefined, undefined, undefined, undefined, s.sets);
  closeSession(s.id);
}

/** The trust card's Refresh: a new tab on the same row in this tab's folder. `keepThis` leaves the old
 *  tab open (it holds a chat); a failed spawn rejects and keeps the tab either way. */
export async function reopenHere(s: TerminalSession, keepThis: boolean): Promise<void> {
  const row = rowOf(s);
  await spawnFrom({ ...row, cwd: undefined }, { label: folderName(s.cwd), cwd: s.cwd }, undefined, undefined, undefined, undefined, s.sets);
  if (!keepThis) closeSession(s.id);
}
