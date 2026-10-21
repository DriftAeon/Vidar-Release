// Saves the open Codex Rendered tabs as the `rendered.codexTabs` pref (launcher/codex-restore.ts
// holds the pure snapshot and gate). sessions.ts binds its tab map and view state in; callers
// (rendered-body, tab-strip, sessions) just call `saveCodexTabs()` after a change.
import { setPref } from "../../prefs";
import { createSaveGate, snapshotCodexTabs, type CodexTabView } from "../../launcher/codex-restore";
import type { TerminalSession } from "./types";
import { saveTabOrder } from "./tab-order";

let sessions: ReadonlyMap<string, TerminalSession> = new Map();
let orderedIds: () => string[] = () => [];
let getActiveId: () => string | null = () => null;

/** sessions.ts, at load: the tab map, the strip order and the focused id. */
export function bindCodexSave(deps: {
  sessions: ReadonlyMap<string, TerminalSession>;
  orderedIds: () => string[];
  getActiveId: () => string | null;
}) {
  sessions = deps.sessions;
  orderedIds = deps.orderedIds;
  getActiveId = deps.getActiveId;
}

/** Per tab: the thread the body last reported and whether it has turns. A thread with no turns
 *  cannot be resumed, so it is saved as null. */
const turns = new Map<string, { sid: string | null; turned: boolean }>();

/** createSession with `resume`: the thread already has turns. */
export function noteCodexResume(id: string, resume: string | undefined) {
  if (resume) turns.set(id, { sid: resume, turned: true });
}

/** onSession: a different thread id after the first one (/clear) starts a thread with no turns. */
export function noteCodexSession(id: string, sid: string) {
  const t = turns.get(id) ?? { sid: null, turned: false };
  if (t.sid !== null && sid && t.sid !== sid) t.turned = false;
  if (sid) t.sid = sid;
  turns.set(id, t);
}

/** The tab ran a prompt (turn activity or a finished reply). */
export function noteCodexTurn(id: string) {
  const t = turns.get(id) ?? { sid: null, turned: false };
  if (t.turned) return;
  t.turned = true;
  turns.set(id, t);
  saveCodexTabs();
}

export function forgetCodexTab(id: string) {
  turns.delete(id);
}

function snapshot() {
  const views = new Map<string, CodexTabView>();
  for (const [id, s] of sessions) {
    // A profiled (bare) tab is saved with its profile and row key: restore respawns it on the Bare
    // transport, so its thread resumes in the Bare home (bare-mode Design 9: never silently default).
    // A Falcon-hosted tab survives the relaunch and comes back through readopt.ts; restoring it
    // too would open the same thread a second time.
    if (s.falconSession || s.rendered?.hosted()) continue;
    views.set(id, {
      tabKey: s.tabKey,
      agent: s.agent,
      body: s.body,
      threadId: s.rendered?.sessionId() ?? null,
      turned: turns.get(id)?.turned ?? false,
      cwd: s.cwd,
      title: s.button.title,
      art: s.button.dataset.art ?? s.agent,
      model: s.model,
      mode: s.rendered?.permissionMode() ?? s.permissionMode ?? "default",
      rulesFile: s.rules?.file ?? null,
      ...(s.profile ? { profile: s.profile } : {}),
      ...(s.profile && s.rowKey ? { rowKey: s.rowKey } : {}),
    });
  }
  return snapshotCodexTabs(orderedIds(), views, getActiveId());
}

export const codexSaveGate = createSaveGate({
  dev: !!import.meta.env?.DEV, // `?.`: the node tests that load sessions.ts have no Vite env
  snapshot,
  write: (list) => { setPref("rendered.codexTabs", list); },
});

window.addEventListener("pagehide", () => codexSaveGate.pagehide());

export function saveCodexTabs() {
  codexSaveGate.save();
  saveTabOrder();
}
