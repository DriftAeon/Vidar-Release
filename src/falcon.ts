import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "./ipc";
import type { FalconSessionSummary } from "./ipc";
import { createFalconAdoptTransport, createRenderedBody, type RenderedBody } from "./panels/rendered";
import { withDetachNote } from "./panels/rendered/detach-note";
import { isAgentId } from "./agents/id";
import { adoptRefusal } from "./launcher/readopt";
import { isPermissionMode, type PermissionMode } from "./agents/protocol";
import { firstLine, prettyModel } from "./format";
import { applyThemeAttr } from "./theme";

// Wire shapes live in ipc.ts next to the falcon_list / falcon_handoff_peek entries.
type HostedSession = FalconSessionSummary;

function required<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Falcon shell is missing #${id}`);
  return value as T;
}

const host = required<HTMLElement>("falcon-body");
const picker = required<HTMLSelectElement>("falcon-picker");
const refresh = required<HTMLButtonElement>("falcon-refresh");
const closeSession = required<HTMLButtonElement>("falcon-close-session");
const dock = required<HTMLButtonElement>("falcon-dock");
const status = required<HTMLElement>("falcon-status");
const appWindow = getCurrentWindow();
let body: RenderedBody | null = null;
let selected: HostedSession | null = null;
let switching = false;
let closingWindow = false;
/** Close Session click in flight; keeps onAlive from re-enabling its buttons. */
let closingSession = false;
/** Session id being docked, from before `detachBody()` until the verdict is
 *  in. While set, the shell's own poll and focus reload must not re-adopt
 *  the session mid-ask (the unattended auto-show may still
 *  raise this window in that gap; it just must not steal the session back). */
let docking: string | null = null;
/** Session id this shell just handed to Vidar via Dock. Excluded from every
 *  auto-select fallback in the very next `loadSessions` call, so that refresh
 *  cannot re-adopt the session mid-transfer and race Vidar's fresh lease
 *  Consumed (reset to null) by that one call. */
let justDocked: string | null = null;

/** A compatible staged frontend that is not the one loaded (falcon_frontend_status); the
 *  status line shows "Update Ready" + Reload while it holds and no other message is up. */
let updateReady = false;
/** A staged frontend that is not loaded and cannot be (different shell, or it did not boot):
 *  the reason text ("" when the host gave none), null while that does not hold. The status
 *  line shows "UI Behind Vidar" and no Reload button. */
let behind: string | null = null;
let reloadButton: HTMLButtonElement | null = null;
/** The status line currently shows the update/behind row rather than a message. */
let idleRowShown = false;
/** Reload sequence in flight (detach, swap, page reload). */
let reloading = false;

function showStatus(message = "", error = false): void {
  reloadButton = null;
  idleRowShown = false;
  status.title = "";
  if (!message && updateReady) { renderUpdate(); return; }
  if (!message && behind !== null) { renderBehind(); return; }
  status.textContent = message;
  status.classList.toggle("visible", Boolean(message));
  status.classList.toggle("error", error);
}
/** Reload is safe only when nothing in the open session would be lost: not mid-turn or
 *  hydrating, no approval card waiting, nothing queued. No body at all is safe too. */
function reloadAllowed(): boolean {
  if (reloading || switching || docking !== null || closingWindow || closingSession) return false;
  if (!body) return true;
  return !body.isBusy() && body.drive().cards.length === 0 && body.queuedCount() === 0;
}
function renderUpdate(): void {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Reload";
  button.disabled = !reloadAllowed();
  button.title = "Available when the session is idle with no pending approval or queued messages.";
  button.addEventListener("click", () => { void reloadFrontend(); });
  reloadButton = button;
  status.replaceChildren(document.createTextNode("Update Ready"), button);
  status.classList.add("visible");
  status.classList.remove("error");
  idleRowShown = true;
}
function renderBehind(): void {
  status.textContent = "UI Behind Vidar";
  status.title = behind ? `Refreshing Falcon ends every hosted session.\n${behind}` : "Refreshing Falcon ends every hosted session."; // copy-ok: full-sentence tooltip
  status.classList.add("visible");
  status.classList.remove("error");
  idleRowShown = true;
}
/** Vidar's theme pref, applied to this shell; any failure keeps the current theme. */
async function syncTheme(): Promise<void> {
  const theme = await invoke("falcon_theme").catch(() => null);
  applyThemeAttr(theme);
}
/** Poll cadence: the 2 s jettison poll and window focus. A status line showing something
 *  else (an error, "Opening...") is left alone; the update row returns when it clears. */
async function pollFrontend(): Promise<void> {
  if (reloading) return;
  const next = await invoke("falcon_frontend_status").catch(() => null);
  if (!next) return;
  const differs = next.staged !== null && next.staged !== next.loaded;
  const ready = next.compatible && differs;
  const behindNow = !next.compatible && differs ? (next.reason ?? "") : null;
  if (ready !== updateReady || behindNow !== behind) {
    updateReady = ready;
    behind = behindNow;
    // Redraw only over an empty line or the previous idle row; an error or "Opening..." stays.
    if (!status.classList.contains("visible") || idleRowShown) showStatus("");
  } else if (reloadButton) {
    reloadButton.disabled = !reloadAllowed();
  }
}
/** Plan 2c / 7: gate, mark switching, save the draft through the jettison handoff,
 *  detach, swap the asset set in Rust, reload the page. The reloaded shell's
 *  loadSessions peeks that handoff and re-adopts with the draft. Nothing reloads
 *  unless the swap is confirmed; a failure after the detach re-adopts from the handoff. */
async function reloadFrontend(): Promise<void> {
  if (!reloadAllowed()) return;
  const session = selected?.session ?? null;
  switching = true;
  reloading = true;
  showStatus("Reloading...");
  let detached = false;
  try {
    if (body && session) {
      // Read at the last moment: the handoff write and detach follow with nothing between.
      const draft = body.draft();
      await invoke("falcon_handoff_write", { session, draft, direction: "jettison" });
      try {
        await detachBody();
      } catch (error) {
        await invoke("falcon_handoff_clear", { direction: "jettison", session }).catch(() => {});
        throw error;
      }
      detached = true;
    }
    await invoke("falcon_frontend_reload");
  } catch (error) {
    reloading = false;
    switching = false;
    if (detached) await loadSessions();
    showStatus(`Reload failed: ${firstLine(String(error))}`, true);
  }
}
function mode(value: string): PermissionMode {
  return isPermissionMode(value) ? value : "default";
}
function displayName(session: HostedSession, marked = false): string {
  const leaf = session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd;
  const model = session.model ? ` · ${prettyModel(session.model)}` : "";
  const queued = session.queued_prompts.length ? ` · ${session.queued_prompts.length} queued` : "";
  return `${marked ? "! " : ""}${leaf}${model}${queued}`;
}
function empty(message: string): void {
  host.replaceChildren(Object.assign(document.createElement("div"), { className: "falcon-empty", textContent: message }));
}
async function detachBody(): Promise<void> {
  if (!body) return;
  const old = body;
  await old.detach();
  old.dispose();
  body = null;
  selected = null;
  closeSession.disabled = true;
  dock.disabled = true;
}

async function adopt(session: HostedSession, draft?: string, detached = false): Promise<void> {
  if (switching || session.exited !== null) return;
  // An unknown agent is refused, never opened as Claude. Codex is not gated here: this window
  // never reads the hostedCodex gate, and it has always opened a hosted Codex session as Codex.
  const agent = session.agent;
  if (!isAgentId(agent)) {
    showStatus(adoptRefusal(session) ?? `Unknown agent "${agent}": Vidar cannot open this session.`, true);
    return;
  }
  switching = true;
  picker.disabled = true;
  showStatus(`Opening ${displayName(session)}...`);
  try {
    await detachBody();
    selected = session;
    const next = createRenderedBody({
      tabId: "falcon-shell", tabName: session.tab_name ?? null, host: "falcon-shell", agent, cwd: session.cwd,
      model: session.model, effort: null, permissionMode: mode(session.permission_mode),
      // a gateway or bare session's /clear respawns under the same gateway or profile, not plain
      // Claude (the shell itself refuses a profiled spawn: it has no home to prepare)
      transport: withDetachNote(createFalconAdoptTransport(session.session, session.gateway, session.profile, false, session.row_key), detached),
      resume: session.conversation ?? null, draft: draft ?? null, onAdopted: null,
      // the host's echo of the rules file, so a /clear respawn keeps the tab's rules
      rules: session.rules_file ? { file: session.rules_file, codex: null, warnings: [] } : null,
      resumeNotice: null,
      onResume: () => { void openPicker(); },
      onSelectWorkspace: null, // no launcher in this window: a home refusal shows Retry only
      onReopenHere: null, // likewise: the trust card shows no Refresh
      onOpenWorktree: null, // likewise: a Vidar-folder refusal shows the notice and Retry only
      // The conversation id stays off the header (2026-10-03); it lives in the Falcon
      // launcher row's tooltip and will get its own place later.
      onSession: null,
      onModeChange: null,
      onDead: () => { closeSession.disabled = true; dock.disabled = true; },
      // A respawn can finish while a switch, dock or close is tearing this
      // body down (stopAgent awaits it first); leave the buttons alone then.
      onAlive: () => {
        if (body !== next || switching || docking !== null || closingWindow || closingSession) return;
        closeSession.disabled = false; dock.disabled = false;
      },
      // no character view in the shell, and nothing marks a background tab
      onActivity: null, onCharacterStatus: null, onCharacterActivity: null, onCharacterCompletion: null,
      onReplyDone: null, onToolStart: null, onToolDone: null, onTabState: null,
    });
    body = next;
    host.replaceChildren(next.el);
    closeSession.disabled = false;
    dock.disabled = false;
    showStatus(session.degraded ? `Read only: ${session.degraded}` : "");
    next.focus();
  } catch (error) {
    // A refused detach leaves the old controller and body intact. Keep that
    // view visible so an attempted switch cannot strand a live session.
    if (!body) {
      selected = null;
      empty("Could not open the session.");
    }
    showStatus(`Open failed: ${firstLine(String(error))}`, true);
  } finally {
    switching = false;
    picker.disabled = false;
  }
}

/** Titlebar close and the empty-shell auto-close share this: end the hosted
 *  session (like a normal tab close, not a detach), then destroy the window.
 *  A failed shutdown leaves the session attached and the window up — it is
 *  the only surface left to show the error. */
async function closeShellWindow(): Promise<void> {
  if (closingWindow || switching || reloading) return;
  closingWindow = true;
  showStatus("Closing session...");
  try {
    if (body) {
      // Close is the destructive hosted-session action: it terminates
      // Falcon's child, not just this window's view of it (matches
      // closeHostedTab in panels/sessions/hosted.ts).
      await body.shutdown();
      body = null;
      selected = null;
      closeSession.disabled = true;
      dock.disabled = true;
    }
    await appWindow.destroy();
  } catch (error) {
    closingWindow = false;
    showStatus(`Window close failed: ${firstLine(String(error))}`, true);
  }
}

/** After a Dock verdict or a Close Session, the shell has done its job when
 *  the reload that followed adopted nothing: close the window rather than
 *  leave it up and empty. `listed` is that reload's result; a failed list
 *  keeps the window so its error stays readable. Never called on startup —
 *  a shell opened with nothing to show was opened on purpose. */
async function closeShellIfEmpty(listed: boolean): Promise<void> {
  if (!listed || body || switching || docking) return;
  await closeShellWindow();
}

/** Resolves true when the host answered the list, whatever it held. */
async function loadSessions(preferred?: string): Promise<boolean> {
  // A Dock in flight owns the lease transfer end to end: any refresh landing
  // in that window (poll, focus, a queued click) must not touch the picker
  // or auto-adopt anything — `docking` already blocks the two triggers that
  // used to call in here, but this is the backstop for every other one.
  if (docking) return false;
  const skipAutoSelect = justDocked;
  justDocked = null;
  refresh.disabled = true;
  try {
    const payload = await invoke("falcon_list");
    // The shell renders Claude and hosted Codex sessions (a durable transport picks the hosted
    // Codex adapter); any other agent stays unlisted. Only a gated-on Vidar starts hosted Codex,
    // so with the gate off the list is today's. The summary always carries `agent`.
    const sessions = (payload.sessions ?? []).filter((session) => isAgentId(session.agent));
    picker.replaceChildren();
    if (!sessions.length) {
      picker.append(new Option("No Hosted Sessions", ""));
      picker.disabled = true;
      if (!body) empty("No hosted session.");
      showStatus("");
      return true;
    }
    picker.append(new Option("None", ""));
    for (const session of sessions) {
      // A session other than the one already open gets marked, not switched
      // to: the user may be mid-keystroke in the open one, and a background
      // pending permission is not urgent enough to steal focus.
      const marked = Boolean(selected) && session.session !== selected?.session
        && session.pending_permissions.length > 0;
      const option = new Option(displayName(session, marked), session.session);
      option.disabled = session.exited !== null;
      option.title = session.exited === null ? session.cwd : `Exited (${session.exited})`;
      picker.append(option);
    }
    picker.disabled = false;
    // The session just handed off via Dock is excluded from every auto-pick
    // fallback for this one call: Falcon still lists it as hosted the instant
    // after, and picking it back up here would race Vidar's fresh lease.
    // Held elsewhere = `attached > 0` while this shell has no body: a proxy, because SessionSummary
    // (protocol.rs) exposes no lease field, so viewer-only subscribers are skipped too. Auto-picks
    // only; `preferred` and the picker still adopt such a session.
    const heldElsewhere = (session: { attached: number }) => !body && session.attached > 0;
    const auto = sessions.filter((session) => session.session !== skipAutoSelect && !heldElsewhere(session));
    const keepSelected = selected && !heldElsewhere(sessions.find((s) => s.session === selected?.session) ?? { attached: 0 })
      ? selected.session : undefined;
    const withPendingPermission = auto.filter((session) => session.pending_permissions.length > 0);
    // A `jettison` handoff only ever competes for the SAME picker slot a
    // caller-supplied `preferred` already fills, and reading it is a peek: a
    // `switching`/`docking` early return here must not have consumed anything
    // (review blockers 2, 3).
    let jettisonDraft: string | undefined;
    if (!preferred && !switching && !docking) {
      const h = await invoke("falcon_handoff_peek", { direction: "jettison" }).catch(() => null);
      if (h) {
        preferred = h.session;
        jettisonDraft = h.draft;
      }
    }
    const wanted = preferred
      ?? keepSelected
      ?? (withPendingPermission.length === 1 ? withPendingPermission[0].session : undefined)
      ?? (auto.length === 1 ? auto[0].session : "");
    picker.value = wanted;
    const match = sessions.find((session) => session.session === wanted && session.exited === null);
    if (match && match.session !== selected?.session) {
      await adopt(match, jettisonDraft, jettisonDraft !== undefined && match.session === preferred);
      if (jettisonDraft !== undefined && selected?.session === match.session) {
        await invoke("falcon_handoff_clear", { direction: "jettison", session: match.session }).catch(() => {});
      }
    }
    return true;
  } catch (error) {
    picker.replaceChildren(new Option("Hosted Sessions Unavailable", ""));
    picker.disabled = true;
    if (!body) empty("Could not list sessions.");
    showStatus(`Session list failed: ${firstLine(String(error))}`, true);
    return false;
  } finally { refresh.disabled = false; }
}

async function openPicker(): Promise<void> {
  await loadSessions();
  picker.focus();
  (picker as HTMLSelectElement & { showPicker?: () => void }).showPicker?.();
}

picker.addEventListener("change", () => {
  if (!picker.value) return;
  void invoke("falcon_list")
    .then((payload) => payload.sessions.find((session) => session.session === picker.value))
    .then((session) => session && adopt(session))
    .catch((error) => showStatus(`Session list failed: ${firstLine(String(error))}`, true));
});
refresh.addEventListener("click", () => { void loadSessions(); });
closeSession.addEventListener("click", async () => {
  if (closingSession || switching || reloading || !body || !selected || !window.confirm("Close this hosted session? Its agent process will stop.")) return;
  closingSession = true;
  closeSession.disabled = true;
  dock.disabled = true;
  showStatus("Closing session...");
  try {
    const old = body;
    await old.shutdown();
    old.dispose();
    body = null; selected = null;
    closingSession = false;
    empty("");
    await closeShellIfEmpty(await loadSessions());
  } catch (error) {
    closingSession = false;
    closeSession.disabled = false;
    dock.disabled = false;
    showStatus(`Close Session failed: ${firstLine(String(error))}`, true);
  }
});

/** The Dock path itself: detach -> handoff -> `falcon_dock_ask`, with the
 *  same rollback-to-adopted-and-settled behaviour on any non-approved
 *  outcome. Shared by the button click and the script-driven poll below
 *  (`falcon_dock_request_claim`) so there is exactly one copy of it; the two
 *  callers differ only in what they do with the `{ok, reason}` it returns. */
const DOCK_WRONG_SESSION_REASON = "not the session this shell is showing";

/** `listed` (success only) is the post-dock reload's verdict for
 *  `closeShellIfEmpty`. The close is the caller's to run, after it has
 *  settled anything a destroyed window would strand: the script poll must
 *  write `dock-result.json` first or `tools\falcon\dock.ps1` waits forever. */
async function runDock(session: string): Promise<{ ok: boolean; reason?: string; listed?: boolean }> {
  if (!body || !selected || selected.session !== session) {
    return { ok: false, reason: DOCK_WRONG_SESSION_REASON };
  }
  const draft = body.draft();
  docking = session;
  // `docking` already stops the poll/focus reload and `loadSessions` itself
  // from touching anything; these two are the controls a direct click can
  // still reach mid-ask.
  refresh.disabled = true;
  picker.disabled = true;
  showStatus("Docking into Vidar...");
  try {
    await detachBody();
    await invoke("falcon_handoff_write", { session, draft, direction: "dock" });
    const verdict = await invoke("falcon_dock_ask", { session });
    if (verdict !== "approved") throw new Error(`Vidar ${verdict} the dock`);
    docking = null;
    justDocked = session;
    showStatus("Docked into Vidar.");
    empty("Docked into Vidar.");
    const listed = await loadSessions();
    return { ok: true, listed };
  } catch (error) {
    // Any non-approved outcome — including a false one (live proof: a claim
    // answered inside one poll tick used to read as "Vidar is not running"
    // for a dock that had already succeeded) — must always settle the shell
    // back to a usable state: clear every in-flight flag, re-enable the
    // controls a direct click can still reach, and rebuild the picker from
    // the host rather than trust local state (review proof steps 4-5; a
    // stuck `docking`/stale picker previously needed a manual reload).
    docking = null;
    switching = false;
    justDocked = null;
    await invoke("falcon_handoff_clear", { direction: "dock", session }).catch(() => {});
    showStatus(`Dock failed: ${firstLine(String(error))}`, true);
    refresh.disabled = false;
    picker.disabled = false;
    try {
      const payload = await invoke("falcon_list");
      const match = payload.sessions.find((s) => s.session === session && s.exited === null);
      if (match) await adopt(match, draft);
    } catch { /* the list itself failed; loadSessions below still refreshes what it can */ }
    await loadSessions();
    return { ok: false, reason: String(error) };
  }
}

dock.addEventListener("click", async () => {
  if (!body || !selected) return;
  const { ok, listed } = await runDock(selected.session);
  if (ok) await closeShellIfEmpty(listed ?? false);
});

await appWindow.onCloseRequested(async (event) => {
  if (closingWindow) return;
  event.preventDefault();
  await closeShellWindow();
});

// `show` on an already-open shell neither focuses nor reloads it
// (ipc.rs create_window: focus only on a newly created window), so a
// Jettison landing while this window is already up needs its own poll.
window.setInterval(() => {
  void pollFrontend();
  void syncTheme();
  if (switching || docking) return;
  // Gate-then-reload, not gate-then-adopt: this only decides whether a
  // reload is worth it. `loadSessions()` (no `preferred`) does the real
  // peek+adopt+clear itself, so the draft and the clear are never skipped
  // the way passing `h.session` as `preferred` used to skip them.
  void invoke("falcon_handoff_peek", { direction: "jettison" })
    .then((h) => {
      if (!h || switching || docking) return;
      // A stale banner from an earlier failure (Dock, a refused open, …)
      // must not keep reading as current once a fresh handoff is about to
      // be adopted (review proof steps 4-5).
      showStatus("");
      void loadSessions();
    })
    .catch(() => {});
}, 2000);

// tools\falcon\dock.ps1's trigger: `open.rs` cannot drive this one (module header,
// `falcon_dock_request_claim`), so the shell claims its own request file
// every 500 ms — short, because a script is blocked on `dock-result.json`
// the whole time. `docking`/`switching` guard this the same as the jettison
// poll above: a Dock already in flight (button or script) must not overlap
// a second one.
window.setInterval(() => {
  if (switching || docking) return;
  void invoke("falcon_dock_request_claim")
    .then(async (claim) => {
      if (!claim) return;
      if (!claim.fresh) {
        await invoke("falcon_dock_result_write", { session: claim.session, id: claim.id, ok: false, reason: "stale" }).catch(() => {});
        return;
      }
      const { ok, reason, listed } = await runDock(claim.session);
      if (!ok && reason === DOCK_WRONG_SESSION_REASON) {
        // Not a real refusal, likely a race between two shell windows:
        // restore the request instead of settling it
        // with a verdict, so the shell that actually holds the session can
        // still claim and action it.
        await invoke("falcon_dock_request_release").catch(() => {});
        return;
      }
      await invoke("falcon_dock_result_write", { session: claim.session, id: claim.id, ok, reason: reason ?? null }).catch(() => {});
      // Only now: the script has its verdict, so a destroyed window strands nothing.
      if (ok) await closeShellIfEmpty(listed ?? false);
    })
    .catch(() => {});
}, 500);

void appWindow.onFocusChanged(({ payload: focused }) => {
  if (!focused || switching || docking) return;
  showStatus("");
  void pollFrontend();
  void loadSessions();
});

// Boot is complete once the first session list has answered (whatever it held): tells the host
// this frontend works, so its watchdog does not fall back to the embedded one.
void loadSessions().finally(() => { void invoke("falcon_frontend_booted").catch(() => {}); });
void pollFrontend();
void syncTheme();
