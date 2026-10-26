// Rendered body: a tab's Rendered transcript (panels/rendered.ts) in place of an xterm, with
// its callbacks wired to focus, character and reply events. sessions.ts binds its deps in.
import { createFalconAdoptTransport, createRenderedBody, falconAgentTransport } from "../rendered";
import { createFalconProfileTransport, createGatewayTransport, createProfileTransport, createRefusedTransport } from "../rendered/transport";
import { claudeArt } from "./gateway-art";
import { AGENT_PROFILE, codexHostShape } from "../rendered/agent-profile";
import { hostedCodexOn } from "../../launcher/readopt";
import { invoke } from "../../ipc";
import { dispatchCharacterActivity, dispatchCharacterCompletion, dispatchCharacterStatus } from "../../character/events";
import { dispatchReplyDone } from "../reply-events";
import { noteCodexSession, noteCodexTurn, saveCodexTabs } from "./codex-save";
import { feedDetached, feedRendered } from "./tab-state-feeds";
import type { TerminalSession } from "./types";
import { rescueBottombar } from "./bottombar-dock";
import { hostedFalconSession } from "./lookup";
import { saveTabOrder } from "./tab-order";
import { noteToolStart } from "../../unreal/touched";
let sessions: ReadonlyMap<string, TerminalSession> = new Map();
let getActiveId: () => string | null = () => null;
let dispatchFocus: () => void = () => {};

/** sessions.ts, at load: the tab map, the focused id and the focus event. */
export function bindRenderedBody(deps: {
  sessions: ReadonlyMap<string, TerminalSession>;
  getActiveId: () => string | null;
  dispatchFocus: () => void;
}) {
  sessions = deps.sessions;
  getActiveId = deps.getActiveId;
  dispatchFocus = deps.dispatchFocus;
}

/* ---- rendered body (panels/rendered.ts) ----
   The container hosts the transcript instead of an xterm; no pty, no fit.
   Activity, death and the session id come back through callbacks so the
   strip and the focus event behave exactly as for a terminal. */

/** Bodies whose tab already left the bar but are still stopping off-DOM (instant close): their
 *  character, reply and tool events are dropped, since the id no longer names a tab. */
const retired = new WeakSet<object>();
export function retireRenderedBody(body: object) {
  retired.add(body);
}

/** A Codex tab that may run in Falcon (gate on, no rules file, no profile, not an adopt): only
 *  then is the host asked, since `falcon_list` launches one. Sync, so with the gate off
 *  createSession attaches without an await, as before. */
export function codexMayHost(s: TerminalSession): boolean {
  return s.agent === "codex" && !s.falconSession
    && codexHostShape({ hostedCodex: hostedCodexOn(), rulesFile: s.rules?.file ?? null, profile: s.profile ?? null });
}

/** The host's capabilities for `codexMayHost` tabs, asked before the body exists (a body never
 *  changes backend). A failed `falcon_list` means Falcon is unavailable: null, so in-process. */
export async function codexHostCapabilities(): Promise<readonly string[] | null> {
  try {
    return (await invoke("falcon_list")).capabilities ?? null;
  } catch (e) {
    console.warn("hosted Codex: falcon_list failed, staying in-process:", e);
    return null;
  }
}

/** The refused Codex tab's Select Workspace…: the launcher side (launcher/reopen-workspace.ts) binds the
 *  picker and respawn here at startup, so this module imports no launcher code (import-cycles contract). */
let reopenInWorkspace: (s: TerminalSession) => Promise<void> = async () => {};
let reopenHere: (s: TerminalSession, keepThis: boolean) => Promise<void> = async () => {};
let reopenInWorktree: (s: TerminalSession) => Promise<void> = async () => {};
export function bindReopenInWorkspace(fn: (s: TerminalSession) => Promise<void>, here: (s: TerminalSession, keepThis: boolean) => Promise<void>, worktree: (s: TerminalSession) => Promise<void>): void {
  reopenInWorkspace = fn;
  reopenHere = here;
  reopenInWorktree = worktree;
}

export function attachRenderedBody(s: TerminalSession, resume?: string, draft?: string, onAdopted?: (ok: boolean, reason?: string) => void, focus = true, capabilities: readonly string[] | null = null) {
  const { id, container, button } = s;
  s.body = "rendered";
  button.dataset.body = "rendered";
  container.classList.add("rendered-host");
  // Claude is always hosted by Falcon; a Codex tab is hosted when its profile's check admits it
  // (gate on, host capability, no rules file or profile), else it keeps the in-process path.
  // `undefined` means "the default", which is Vidar's own backend.
  const agentKind = s.agent === "codex" ? "codex" : "claude";
  const hosted = AGENT_PROFILE[agentKind].falconHosted({
    hostedCodex: hostedCodexOn(), capabilities, rulesFile: s.rules?.file ?? null, profile: s.profile ?? null,
  });
  // A gateway tab carries its identity in the tab art (adoptHosted sets it from the host's summary).
  // An art the module registry does not know fails closed: it adopts, but never respawns as plain Claude.
  const art = agentKind === "claude" ? claudeArt(button.dataset.art) : { kind: "plain" } as const;
  const gateway = art.kind === "gateway" ? art.id : undefined;
  const refused = art.kind === "unknown";
  // A profiled (bare) tab keeps its profile on every spawn: Falcon's for Claude
  // (createFalconProfileTransport, and through a re-adopt), in-process for Codex (createProfileTransport).
  const transport = s.falconSession
    ? createFalconAdoptTransport(s.falconSession, gateway, s.profile, refused, s.rowKey, s.sets, s.vault)
    : refused ? createRefusedTransport()
    : gateway ? createGatewayTransport(gateway)
    : hosted ? (s.profile ? createFalconProfileTransport(s.profile, s.rowKey, s.sets, s.vault) : falconAgentTransport)
    : s.profile ? createProfileTransport(s.profile, s.rowKey, s.sets, s.vault) : undefined;
  // the body shows prepare-time warnings once; the tab keeps the file for Resume and a switch back
  const rules = s.rules ?? null;
  if (s.rules) s.rules = { ...s.rules, warnings: [] };
  const body = createRenderedBody({
    tabId: id,
    tabName: button.title || null, // VIDAR_TAB_NAME for the spawned process; the host keeps it for a re-adopt
    rules,
    host: "vidar-tab",
    agent: agentKind,
    transport: transport ?? null,
    cwd: s.cwd,
    model: s.model ?? null,
    effort: s.effort ?? null,
    permissionMode: s.permissionMode ?? "default",
    resume: resume ?? null,
    draft: draft ?? null,
    onAdopted: onAdopted ?? null,
    // a pick opens a new tab; this body keeps running
    // a Bare tab's threads live in its own home: the event carries its profile and row key so the
    // launcher lists that home and opens the pick on the same row
    resumeNotice: null,
    onResume: () => document.dispatchEvent(new CustomEvent("vidar-open-resume", {
      detail: { agent: agentKind, cwd: s.cwd, ...(s.profile ? { profile: s.profile, rowKey: s.rowKey } : {}) },
    })),
    onSelectWorkspace: () => reopenInWorkspace(s),
    onReopenHere: (keepThis) => reopenHere(s, keepThis),
    onOpenWorktree: () => reopenInWorktree(s),
    onSession: (info) => {
      const cur = sessions.get(id);
      if (!cur || cur.rendered !== body) return;
      cur.model = info.model || cur.model;
      if (id === getActiveId()) dispatchFocus();
      if (agentKind === "codex") { noteCodexSession(id, info.sessionId); saveCodexTabs(); }
    },
    onModeChange: () => {
      const cur = sessions.get(id);
      if (cur && cur.rendered === body && agentKind === "codex") saveCodexTabs();
    },
    onAlive: () => {
      const cur = sessions.get(id);
      if (!cur || cur.rendered !== body) return;
      cur.alive = true;
      cur.button.classList.remove("dead");
      if (body.hosted() && !cur.falconSession && !cur.tabOrderFalconSession) {
        void hostedFalconSession(id).then((session) => {
          if (session && sessions.get(id) === cur && cur.rendered === body) {
            cur.tabOrderFalconSession = session;
            saveTabOrder();
          }
        });
      }
      if (id === getActiveId()) dispatchFocus();
    },
    onDead: () => {
      const cur = sessions.get(id);
      if (!cur || cur.rendered !== body) return;
      cur.alive = false;
      cur.button.classList.add("dead");
      if (id === getActiveId()) dispatchFocus();
    },
    // no background-activity dots: the raw Codex TUI
    // repaints while idle, so the dot never cleared and read as a stuck alert
    onActivity: null,
    onCharacterStatus: (status) => { if (!retired.has(body)) dispatchCharacterStatus({ id, ...status }); },
    onCharacterActivity: (active) => {
      if (retired.has(body)) return;
      if (active && agentKind === "codex") noteCodexTurn(id); // the thread now has a turn: resumable
      dispatchCharacterActivity({ id, active });
    },
    onCharacterCompletion: () => { if (!retired.has(body)) dispatchCharacterCompletion({ id }); },
    onReplyDone: () => { if (!retired.has(body)) dispatchReplyDone({ id, agent: agentKind, cwd: s.cwd, profile: s.profile ?? null }); },
    onToolStart: (_toolUseId, name, input) => { if (!retired.has(body)) noteToolStart(id, name, input); },
    onToolDone: null,
    // may fire while the body is still being built (`body` is not bound yet): the tab map guards a closed tab
    onTabState: (chip, pendingTool, hydrating) => { if (sessions.has(id)) feedRendered(id, chip, pendingTool, hydrating); },
  });
  s.rendered = body;
  s.alive = true;
  button.classList.remove("dead");
  container.appendChild(body.el);
  if (focus) body.focus();
}

export function detachRenderedBody(s: TerminalSession) {
  s.rendered?.dispose();
  s.rendered = undefined;
  if (sessions.has(s.id)) feedDetached(s.id);
  s.container.classList.remove("rendered-host");
  rescueBottombar(s.container); // a docked bottom bar must not be cleared with the body
  s.container.textContent = "";
}
