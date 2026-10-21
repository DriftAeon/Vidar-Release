// src\launcher\reopen-workspace.ts — the refused Codex tab's Select Workspace… (a home-folder refusal,
// codex_cwd.rs): pick a folder, open a tab of the same agent, body and Bare profile there, close the
// refused one. main.ts binds it into the rendered body (panels/sessions/rendered-body.ts).
import type { TerminalSession } from "../panels/sessions/types";
import { closeSession } from "../panels/sessions";
import { agentKind } from "./agent-kind";
import { shownRoots, shownVariants, spawnFrom } from "./roster";
import { pickWorkspace } from "./workspaces";

/** The tab's launcher row: the Bare row by its key, else the plain Rendered row of its agent (the Bare
 *  Rendered row when the plain rows are off). Cancel
 *  resolves without doing anything; a failed spawn rejects with its message and keeps the tab. */
export async function reopenInWorkspace(s: TerminalSession): Promise<void> {
  const art = s.button.dataset.art;
  const rows = shownRoots().flatMap((r) => [r, ...shownVariants(r)]).filter((x) => agentKind(x.id) === s.agent && x.body === "rendered" && !x.role);
  const ofArt = (x: { id: string }) => !art || x.id === art;
  // a plain tab keeps its plain Rendered row while it is shown, else it falls back to the Bare one
  const row = s.rowKey ? rows.find((x) => x.key === s.rowKey) : rows.find((x) => !x.profile && ofArt(x)) ?? rows.find((x) => x.profile && ofArt(x));
  if (!row) throw new Error("No Launcher Row For This Tab");
  const loc = await pickWorkspace();
  if (!loc) return;
  await spawnFrom({ ...row, cwd: undefined }, loc);
  closeSession(s.id);
}
