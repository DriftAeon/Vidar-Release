// Codex Rendered tabs across a relaunch. Falcon does not host Codex, so a swap or window close
// ends every in-process app-server; the open tabs are saved as the `rendered.codexTabs` pref
// (snapshot) and reopened at boot as resumed threads (restore). A thread with no turns cannot be
// resumed (verified in W1), so a tab that never ran a prompt saves `threadId: null` and comes
// back as a fresh thread. No runtime imports, so it is testable under plain node.
import type { CodexTabRecord } from "../prefs-core";
import type { SetRef } from "../ipc";
// @ts-ignore TS5097: node --test loads this pure module directly
import { isAgentId, type AgentId } from "../agents/id.ts";

const savesRenderedTabs: Record<AgentId, boolean> = { claude: false, codex: true };

const MODES: readonly string[] = ["default", "acceptEdits", "plan"];

/** One tab as sessions.ts sees it; `threadId` is the body's `sessionId()`, `turned` whether the
 *  tab has dispatched a prompt (or resumed a thread that already has turns). */
export interface CodexTabView {
  tabKey?: string;
  agent: string;
  body: string;
  threadId: string | null;
  turned: boolean;
  cwd: string;
  title: string;
  art: string;
  model: string | undefined;
  mode: string;
  rulesFile: string | null;
  /** Bare launch profile and row key of a profiled tab. */
  profile?: string;
  rowKey?: string;
  sets?: SetRef[];
  /** The Rune Vault a profiled tab loaded: a restore resumes the thread on it (R4). */
  vault?: string;
}

/** Every Codex Rendered tab in `order` (the strip's DOM order); other tabs are skipped. */
export function snapshotCodexTabs(
  order: readonly string[],
  tabs: ReadonlyMap<string, CodexTabView>,
  activeId: string | null,
): CodexTabRecord[] {
  const out: CodexTabRecord[] = [];
  for (const id of order) {
    const t = tabs.get(id);
    if (!t || !isAgentId(t.agent) || !savesRenderedTabs[t.agent] || t.body !== "rendered") continue;
    out.push({
      ...(t.tabKey ? { tabKey: t.tabKey } : {}),
      threadId: t.turned && t.threadId ? t.threadId : null,
      cwd: t.cwd,
      title: t.title,
      art: t.art,
      model: t.model ?? null,
      mode: MODES.includes(t.mode) ? (t.mode as CodexTabRecord["mode"]) : "default",
      rules: t.rulesFile,
      active: id === activeId,
      ...(t.profile ? { profile: t.profile } : {}),
      ...(t.profile && t.rowKey ? { rowKey: t.rowKey } : {}),
      ...(t.profile && t.vault ? { vault: t.vault } : t.sets !== undefined ? { sets: t.sets } : {}),
    });
  }
  return out;
}

export interface SaveGateDeps {
  /** a dev build never writes: it must not overwrite the release instance's list */
  dev: boolean;
  snapshot: () => CodexTabRecord[];
  write: (list: CodexTabRecord[]) => void;
}

export interface SaveGate {
  /** Rebuild and write the whole list; a no-op in dev, during a restore and after pagehide. */
  save: () => void;
  beginRestore: () => void;
  /** Keep unopened records in later snapshots until a restore succeeds. */
  endRestore: (unopened?: readonly CodexTabRecord[]) => void;
  /** Latch: the window is going away, so the tabs closing with it must not empty the list. */
  pagehide: () => void;
}

export function createSaveGate(deps: SaveGateDeps): SaveGate {
  let restoring = false;
  let gone = false;
  let retained: CodexTabRecord[] = [];
  return {
    save: () => {
      if (deps.dev || restoring || gone) return;
      const current = deps.snapshot();
      const open = new Set(current.map((r) => r.threadId).filter(Boolean));
      retained = retained.filter((r) => !r.threadId || !open.has(r.threadId));
      const hasActive = current.some((r) => r.active);
      deps.write([...current, ...retained.map((r) => ({ ...r, active: r.active && !hasActive }))]);
    },
    beginRestore: () => { restoring = true; },
    endRestore: (unopened = []) => { retained = unopened.map((r) => ({ ...r })); restoring = false; },
    pagehide: () => { gone = true; },
  };
}

export interface RestoreDeps {
  records: readonly CodexTabRecord[];
  /** Stops every live in-process agent (`agent_reap_all`): a webview reload leaves them running. */
  reap: () => Promise<unknown>;
  /** Thread ids already open in a tab. */
  openThreadIds: () => string[];
  /** Opens one background tab; resolves to its tab id. */
  open: (rec: CodexTabRecord) => Promise<string>;
  activeId: () => string | null;
  select: (tab: string) => void;
  gate: SaveGate;
  /** Whether a profiled record's Bare row still exists. A record that fails is never opened (not on
   *  the default home), is passed to `stale` once and then dropped: its thread stays in the Bare
   *  home. Absent: every record resolves. */
  resolves?: (rec: CodexTabRecord) => boolean;
  stale?: (recs: readonly CodexTabRecord[]) => void;
}

/** Reap stale agents, then reopen each record in order, skipping a thread already open. The
 *  `active` record's tab is selected only when no tab is active. Saves stay off until the end,
 *  then one snapshot lands. A failed reap stops before opening or saving (see the reap-failure
 *  regression in codex-restore.test.mjs); failed records remain saved for the next restore. */
export async function restoreCodexTabs(deps: RestoreDeps): Promise<void> {
  deps.gate.beginRestore();
  let unopened: CodexTabRecord[] = [...deps.records];
  try {
    try {
      await deps.reap();
    } catch (e) {
      console.error("codex restore: agent_reap_all failed:", e);
      return;
    }
    const open = new Set(deps.openThreadIds());
    const stale: CodexTabRecord[] = [];
    for (const rec of deps.records) {
      if (rec.threadId && open.has(rec.threadId)) { unopened = unopened.filter((r) => r !== rec); continue; }
      if (rec.profile && deps.resolves && !deps.resolves(rec)) {
        stale.push(rec);
        unopened = unopened.filter((r) => r !== rec);
        continue;
      }
      try {
        const tab = await deps.open(rec);
        unopened = unopened.filter((r) => r !== rec);
        if (rec.threadId) open.add(rec.threadId);
        if (rec.active && deps.activeId() === null) deps.select(tab);
      } catch (e) {
        console.error(`codex restore ${rec.threadId ?? rec.title}:`, e);
      }
    }
    if (stale.length) deps.stale?.(stale);
  } finally {
    deps.gate.endRestore(unopened);
  }
  deps.gate.save();
}
