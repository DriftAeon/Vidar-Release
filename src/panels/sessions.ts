// Bare imports hold the first-evaluation and CSS order from before the sessions/* split.
import "@xterm/xterm";
import "@xterm/addon-fit";
import "@xterm/addon-unicode11";
import "@xterm/addon-search";
import "@xterm/addon-web-links";
import { invoke } from "../ipc";
import { loadConfig, resolveDefaultCwd } from "../config";
import "@xterm/xterm/css/xterm.css";
import "../theme";
import { mountWorkbench, revealWorkbenchTab, setWorkbenchShown } from "./workbench";
import { initSplit } from "./split";
import { mountRelayPane } from "./relay";
import "./rendered";
import "../character/events";
import "./reply-events";
import "../character/behavior";
import type { LaunchOpts, PageSpec, TerminalSession } from "./sessions/types";
import { armAstra, armedId, bindAstraBridge, disarmAstra, initAstraBridge } from "./sessions/astra-bridge";
import { forgetPair, pairMate, rememberPair } from "./sessions/pair";
import { setShown } from "./sessions/shown";
import { bindTabStrip, buildTabButton, dismissTabMenuFor, initTabStrip, orderedIds, resolveBodyKind } from "./sessions/tab-strip";
import { bindSessionTabOrder, placeRestoredTab, saveTabOrder } from "./sessions/tab-order-bind";
import { bindZoom, initZoom } from "./sessions/zoom";
import { bindSearchOverlay, buildSearchOverlay } from "./sessions/search-overlay";
import { bindOutput } from "./sessions/output";
import { attachTerminalBody, bindTerminalBody, detachTerminalBody, initTerminalBody, syncPty } from "./sessions/terminal-body";
import { initPtyEvents } from "./sessions/pty-events";
import { attachRenderedBody, bindRenderedBody, codexHostCapabilities, codexMayHost } from "./sessions/rendered-body";
import { readHostedCodexGate, setHostedCodexGate } from "../launcher/readopt";
import { dropTabState, feedRaw } from "./sessions/tab-state-feeds";
import { bindCodexSave, forgetCodexTab, noteCodexResume, saveCodexTabs } from "./sessions/codex-save";
import { bindLookup, getFocusedSession, nextTabName } from "./sessions/lookup";
import { bindHosted, closeHostedTab, closeRenderedLocal, jettisonSession } from "./sessions/hosted";
import { dockBottombar, inBottombar, rescueBottombar } from "./sessions/bottombar-dock";

export type { LaunchOpts, PageSpec, SessionAgent, SessionBody } from "./sessions/types";
export { armAstra, armBlocker, disarmAstra, hasArmedAstra, isArmed } from "./sessions/astra-bridge";
export { openSearch } from "./sessions/search-overlay";
export { noteCharacterOutput } from "./sessions/output";
export { clearOpenMessage, hasOpenMessage, markMessageOpen } from "./sessions/message-open";
export { setTerminalTheme } from "./sessions/terminal-body";
export {
  codexThreadHolder, driveSnapshot, findTabByFalconSession, findTabByFalconSessionHosted, getActiveSessionAgent,
  getActiveSessionCwd, getFocusedSession, isPageTab, openFalconSessionIds, openRenderedSessionIds, refreshRawCodexThreads,
  renderedBody, renderedDrive, sessionContainer, sessionKind, sessionLaunchInfo, sessionTitle,
} from "./sessions/lookup";
export type { FocusedSession } from "./sessions/lookup";
export { closeHostedTab, dropUnadoptedTab, isJettisonBusy, jettisonSession } from "./sessions/hosted";

export interface SessionsOpts {
  riderEnabled?: boolean;
  fontSize?: number;
}

const sessions = new Map<string, TerminalSession>();
bindAstraBridge({ sessions, writeToSession });
const BOOT = Date.now().toString(36).slice(-4); // see createSession's id
// VISIBLE and FOCUSED are separate concerns: dual-view shows two panes but only
// one holds focus. activeId stays the focused one, so every existing consumer
// (writeToActive, marquee, tray insert) keeps working unchanged — tools act
// on what you last touched.
let visible: string[] = [];
let activeId: string | null = null;
// The workbench is the one non-terminal pane, always right. Exclusive with
// terminal/terminal: openDual() clears it, openWorkbench() collapses dual.
let workbenchOpen = false;
let counter = 0;
let viewEl: HTMLElement;
/** the empty pane shown in the terminal slot while there are no sessions (layout()) */
let placeholderEl: HTMLElement;
/** the Relay left pane; shown instead of the placeholder while relayOpen and no session is visible */
let relayEl: HTMLElement;
let relayOpen = false;
let showSessionsView: () => void = () => {};
/** Backend-resolved at init (resolveDefaultCwd); undefined only when the backend has none. */
let defaultCwd: string | undefined;
bindTabStrip({
  sessions, view: () => ({ visible, activeId, workbenchOpen }),
  activate, closeSession, openDual, openWorkbench, collapseWorkbench, jettisonSession, closeHostedTab,
  dispatchFocus, focusBody,
});
bindZoom({ sessions, refitActive });
bindSearchOverlay({ sessions, getActiveId: () => activeId, focusBody });
bindOutput({
  sessions,
  // Backpressure only; a failed call is retried by the next watermark edge and
  // bounded by the reader's pause ceiling (pty/flow.rs).
  setFlow: (id, paused) => void invoke("pty_flow", { id, paused }).catch(() => {}),
});
bindTerminalBody({ sessions });
bindRenderedBody({ sessions, getActiveId: () => activeId, dispatchFocus });
bindLookup({ sessions, getActiveId: () => activeId });
bindCodexSave({ sessions, orderedIds, getActiveId: () => activeId });
bindSessionTabOrder(sessions, orderedIds);
bindHosted({ sessions, removeSessionView });

function dispatchFocus() {
  document.dispatchEvent(new CustomEvent("vidar-focus", { detail: getFocusedSession() }));
}

export function getActiveSessionId(): string | null {
  return activeId;
}

export function writeToActive(data: string): Promise<boolean> {
  // Same seam as writeToSession, so a rendered tab gets its composer contract
  // (macros, config and marquee come through here).
  // Resolves false when nothing took the bytes (no tab, a dead tab, a page tab).
  return activeId ? writeToSession(activeId, data) : Promise.resolve(false);
}

/** Writes to one specific session and reports whether the bytes were delivered.
 *  For callers that captured their destination earlier (voice: at hotkey press)
 *  and must not fall through to whichever pane is active by delivery time.
 *  Terminal body: bytes to the pty. Rendered body: text lands unsent in the
 *  composer and a trailing "\r" submits — the one contract every caller has. */
export async function writeToSession(id: string, data: string): Promise<boolean> {
  const s = sessions.get(id);
  if (!s?.alive || s.body === "page") return false; // a page tab has nothing to type into
  if (s.body === "rendered") return s.rendered ? s.rendered.write(data) : false;
  try {
    await invoke("write_pty", { id, data });
    return true;
  } catch {
    return false;
  }
}

function focusBody(s: TerminalSession | undefined) {
  if (!s) return;
  if (s.body === "rendered") s.rendered?.focus();
  else if (s.body === "page") s.container.querySelector<HTMLElement>(".page-host")?.focus({ preventScroll: true });
  else s.term?.focus();
}

export function focusActive() {
  if (activeId) focusBody(sessions.get(activeId));
}

export async function initSessions(
  view: HTMLElement,
  strip: HTMLElement,
  showView: () => void,
  opts?: SessionsOpts,
) {
  viewEl = view;
  initTabStrip(strip);
  showSessionsView = showView;
  placeholderEl = document.createElement("div");
  placeholderEl.className = "term-container term-placeholder pane-left";
  placeholderEl.style.order = "0"; // left of the split grip (order 1), like a real left pane
  viewEl.appendChild(placeholderEl); // aria-hidden unless the first-run card is in it (layout())
  relayEl = mountRelayPane(viewEl, { openRelay, activate, active: getActiveSessionId });
  document.getElementById("relay-btn")?.addEventListener("click", openRelay);
  mountWorkbench(viewEl, { open: openWorkbench, collapse: collapseWorkbench });
  initSplit(viewEl);
  defaultCwd = await resolveDefaultCwd();
  // Read once, before any tab or the boot re-adopt (main.ts awaits this): applies after a restart.
  setHostedCodexGate(readHostedCodexGate((await loadConfig()).config.falcon));
  initTerminalBody(opts?.riderEnabled ?? false);
  initZoom(opts);
  buildSearchOverlay(viewEl);

  await initPtyEvents(sessions, (s) => { if (s.id === activeId) dispatchFocus(); });
  await initAstraBridge();
  // Starts with no session on purpose: no assumed powershell tab. The ＋ button /
  // launcher menu is the front door. But not blank: the
  // workbench opens and an empty pane holds the terminal slot — the same state
  // closing the last tab leaves behind. The first tab replaces the pane
  // (addSession sets visible + workbenchOpen itself).
  workbenchOpen = true;
  layout(false);
}

export async function createSession(opts?: LaunchOpts): Promise<string> {
  const returnTo = opts?.background ? (opts.returnTo ?? activeId) : null;
  // Captured before the spawn makes the new tab active: the handback's fallback
  // when `returnTo` names a tab that is not in the map (see the handback below).
  const previous = activeId;
  // Boot-unique: the Rust pty map outlives a webview reload (dev HMR), and a
  // fresh frontend restarting at s1 replaced the orphan's map entry — whose
  // reader thread then emitted pty-exit for "s1", marking the NEW tab dead.
  // Filename-safe, since VIDAR_TAB names bridge\sessions\<id>.json.
  const id = `s${++counter}-${BOOT}`;

  const container = document.createElement("div");
  container.className = "term-container";
  // inspect-mode labels terminals from these (xterm internals are anonymous)
  container.dataset.sessionId = String(counter);
  // An explicit title wins; else a themed name no open tab uses (tab-names.ts), which ctl verbs accept as an address.
  const title = opts?.title ?? nextTabName(); container.dataset.title = title;
  // In dual-view both panes are visible; clicking or tabbing into one is what
  // moves focus, and focus is what tools target. A control on the bottom bar docked
  // in this pane (sessions/bottombar-dock.ts) is not the pane: it moves nothing.
  container.addEventListener("focusin", (e) => { if (!inBottombar(e.target)) setFocus(id); });
  viewEl.appendChild(container);

  const button = buildTabButton(id, { ...opts, title }, counter);

  // "" = no folder known: spawn_pty then gets null and the backend picks (pty.rs).
  const cwd = opts?.cwd ?? defaultCwd ?? "";
  const { kind, body } = resolveBodyKind(opts);
  const s: TerminalSession = {
    id, container, button, alive: true, body,
    agent: kind, cwd, model: opts?.model, effort: opts?.effort, launchArgs: opts?.args, shell: opts?.shell, role: opts?.role,
    falconSession: opts?.falconSession, rules: opts?.rules, profile: opts?.profile, rowKey: opts?.rowKey,
    tabKey: kind === "codex" && body === "rendered" && !opts?.falconSession
      ? (opts?.tabKey ?? crypto.randomUUID()) : undefined,
    permissionMode: opts?.permissionMode ?? "default",
    ptyCols: 0, ptyRows: 0,
  };
  button.dataset.agent = s.agent; // styles.css colours the tab border by kind
  button.dataset.art = opts?.art ?? s.agent; // leftbar.css picks the tab mark
  button.dataset.body = body;
  sessions.set(id, s); if (opts?.restoreSlot) placeRestoredTab(id);
  if (opts?.role === "astra" && body === "terminal") armAstra(id);

  // open() requires a visible container: lay out first, then open. A new tab
  // arrives terminal/workbench by default — the pane is the reading space, the
  // tab is the destination; collapse is the opt-out, not open the opt-in.
  // A rendered body launched in the background
  // never becomes the shown/active tab — the terminal path below still does
  // its own show-then-revert dance through `returnTo`.
  const bgRendered = !!opts?.background && body === "rendered";
  if (!bgRendered) {
    visible = [id];
    activeId = id;
    if (!opts?.background) workbenchOpen = true;
  }
  render(true);
  saveTabOrder();
  if (body === "rendered") {
    if (kind === "codex") noteCodexResume(id, opts?.resume);
    // Hosted Codex (gate on): the host's capabilities decide the backend before the body exists.
    // Gate off, or a rules file or profile: no await, no probe, attached as before.
    const capabilities = codexMayHost(s) ? await codexHostCapabilities() : null;
    if (sessions.get(id) !== s) return id; // closed while the host was asked
    attachRenderedBody(s, opts?.resume, opts?.draft, opts?.onAdopted, !bgRendered, capabilities);
    return id;
  }
  // xterm needs a laid-out container to open, so the tab is shown first; a
  // background launch hands the view back to its requester right after.
  //
  // `returnTo` may name a tab that does not exist: a bridge requester sends the
  // tab id from its own $env:VIDAR_TAB, which is validated for SHAPE only by
  // Rust and by the publishing script, never against this map — and a webview
  // reload changes BOOT, so a long-lived shell can hold a stale one. That used
  // to skip the handback in silence and strand the view on the new tab.
  // Fall back to whatever was active before the spawn, and say so.
  await attachTerminalBody(s, { shell: opts?.shell, args: opts?.args });
  if (sessions.get(s.id) === s && s.term) feedRaw(s.id, s.agent, s.alive);
  if (returnTo) {
    const back = sessions.get(returnTo)?.alive ? returnTo
      : (previous && sessions.get(previous)?.alive ? previous : null);
    if (back !== returnTo) {
      console.warn(`launch handback: requester ${returnTo} is not a live tab; ${back ? `returning to ${back}` : "staying on the new tab"}`);
    }
    if (back) {
      activate(back);
      focusActive();
    }
  }
  return id;
}

/* ---- page body ----
   A frontend-only view in the strip: no backend session, no pty, not restored.
   One tab per spec id; opening it again activates the existing tab. Built
   directly rather than through createSession, whose body resolution and attach
   paths all assume an agent. agent stays "shell" internally; data-body="page"
   is what styles.css and every guard read. */
export async function openPageTab(spec: PageSpec): Promise<string> {
  for (const [oid, os] of sessions) {
    if (os.body === "page" && os.pageId === spec.id) {
      activate(oid);
      return oid;
    }
  }
  const id = `s${++counter}-${BOOT}`;
  const container = document.createElement("div");
  container.className = "term-container";
  container.dataset.sessionId = String(counter);
  container.dataset.title = spec.title;
  container.addEventListener("focusin", (e) => { if (!inBottombar(e.target)) setFocus(id); }); // as in createSession
  viewEl.appendChild(container);

  const button = buildTabButton(id, { title: spec.title }, counter);
  const s: TerminalSession = {
    id, container, button, alive: true, body: "page", pageId: spec.id,
    agent: "shell", cwd: defaultCwd ?? "",
    ptyCols: 0, ptyRows: 0,
  };
  button.dataset.agent = s.agent;
  button.dataset.body = "page";
  sessions.set(id, s);

  visible = [id];
  activeId = id;
  workbenchOpen = true;
  render(true);

  const host = document.createElement("div");
  host.className = "page-host";
  host.tabIndex = -1; // focusBody lands keyboard focus here
  container.appendChild(host);
  try {
    s.pageDispose = spec.mount(host);
  } catch (e) {
    removeSessionView(id, s); // no half-built tab left in the strip
    throw e;
  }
  focusBody(s);
  return id;
}

// Single place that reconciles DOM state with `visible` + `activeId` + `workbenchOpen`.
function render(refocus: boolean) {
  showSessionsView();
  layout(refocus);
}

// render() minus the view switch — for state changes that must not yank the
// user off the workbench, e.g. closing the last tab from the strip while
// reading there (the no-survivor branch must do more than dispatch focus).
function layout(refocus: boolean) {
  placeholderEl.style.display = visible.length || relayOpen ? "none" : "block"; // no sessions: the empty pane keeps the slot
  relayEl.style.display = relayOpen && !visible.length ? "block" : "none";
  document.getElementById("relay-btn")?.classList.toggle("active", relayOpen);
  viewEl.classList.toggle("dual", visible.length > 1 || workbenchOpen);
  viewEl.classList.toggle("workbench", workbenchOpen);
  setWorkbenchShown(workbenchOpen);
  setShown(visible, relayOpen || workbenchOpen);
  for (const [oid, os] of sessions) {
    const shown = visible.includes(oid);
    os.container.style.display = shown ? "block" : "none";
    // flex order puts the divider (order 1) between the panes: first visible
    // pane left of it, everything else right — DOM order no longer decides
    const left = oid === visible[0];
    os.container.style.order = left ? "0" : "2";
    os.container.classList.toggle("pane-left", left);
    os.container.classList.toggle("focused", oid === activeId);
    os.button.classList.toggle("active", shown);
    os.button.classList.toggle("focused", oid === activeId);
  }
  // the right mini bar follows the layout (sessions/bottombar-dock.ts). Before the fits, so they
  // size to the space above it.
  dockBottombar(workbenchOpen, visible.length > 1 ? sessions.get(visible[1])?.container : undefined);
  // Fit every VISIBLE pane, not just the focused one — entering/leaving dual
  // view changes both panes' widths.
  for (const id of visible) {
    const s = sessions.get(id);
    if (!s?.term?.element) continue; // a rendered body is a flex child, nothing to fit
    // membership in `visible` is not a geometry check: mid-transition or with
    // the outer view hidden a container can be 0×0, and fitting then corrupts
    // the pty size
    if (!s.container.clientWidth || !s.container.clientHeight) continue;
    syncPty(s);
  }
  if (refocus && activeId) focusBody(sessions.get(activeId));
  // status panel re-targets to the focused tab without importing this module
  dispatchFocus();
}

/** Shows `id` focused: beside its sticky-pair mate (sessions/pair.ts) when it has one and the
 *  workbench is closed (the two layouts are exclusive), else alone. */
export function activate(id: string) {
  if (!sessions.has(id)) return;
  const mate = workbenchOpen ? undefined : pairMate(id, (k) => sessions.has(k));
  // strip order decides left/right, as in openDual
  visible = mate ? orderedIds().filter((k) => k === id || k === mate) : [id];
  activeId = id;
  relayOpen = false;
  render(true);
  saveCodexTabs(); // the `active` flag
}

/** Left-bar Relay button: empties the terminal slot, shows the Relay pane, and switches the
 *  right panel (workbench) to its Relay tab in the same click, opening it if collapsed. */
export function openRelay() {
  if (!relayOpen) {
    visible = [];
    activeId = null;
    relayOpen = true;
    render(false);
  }
  revealWorkbenchTab("relay");
}

/** Map insertion order includes every tab, including inactive/dead sessions. */
export function cycleTab(direction: 1 | -1) {
  const ids = [...sessions.keys()];
  if (!ids.length) return;
  const index = activeId ? ids.indexOf(activeId) : -1;
  const next = index < 0 ? (direction === 1 ? 0 : ids.length - 1)
    : (index + direction + ids.length) % ids.length;
  activate(ids[next]);
}

/** Adds `id` alongside the currently focused session, left-to-right. */
export function openDual(id: string) {
  if (!sessions.has(id)) return;
  const other = activeId && activeId !== id ? activeId : undefined;
  if (!other) {
    activate(id);
    return;
  }
  // strip order decides left/right, so the pair reads the same as the strip
  const ids = orderedIds().filter((k) => k === id || k === other);
  visible = ids;
  rememberPair(id, other);
  activeId = id;
  workbenchOpen = false; // terminal/terminal and workbench are exclusive
  relayOpen = false;
  render(true);
}

export function isDual(): boolean {
  return visible.length > 1;
}

/** Terminal/workbench: the focused terminal alone on the left, workbench right.
 *  Collapses terminal/terminal to the focused pane. Focus is not moved. */
export function openWorkbench() {
  if (visible.length > 1 && activeId) visible = [activeId];
  workbenchOpen = true;
  render(false);
}

/** Back to the single terminal. The pane keeps its content for reopening. */
export function collapseWorkbench() {
  if (!workbenchOpen) return;
  workbenchOpen = false;
  render(true);
}

export function toggleWorkbench() {
  if (workbenchOpen) collapseWorkbench();
  else openWorkbench();
}

export function isWorkbenchOpen(): boolean {
  return workbenchOpen;
}

/** Moves focus without changing which panes are visible. */
function setFocus(id: string) {
  if (activeId === id || !visible.includes(id)) return;
  activeId = id;
  render(false);
}

export function refitActive() {
  if (visible.length) render(false);
}

function removeSessionView(id: string, s: TerminalSession) {
  if (armedId === id) disarmAstra();
  dismissTabMenuFor(id);
  rescueBottombar(s.container); // the bar may be docked in this pane; layout() re-docks it below
  s.container.remove();
  s.button.remove();
  sessions.delete(id);
  dropTabState(id); // invalidate Relay lookups after the tab has left the live map
  forgetPair(id);

  visible = visible.filter((v) => v !== id);
  if (activeId === id) activeId = null;
  if (visible.length) {
    // the surviving pane keeps its slot; dual collapses to single
    if (!activeId) activeId = visible[0];
    render(true);
  } else {
    activeId = null;
    const next = orderedIds()[0];
    if (next) activate(next);
    else layout(false); // no terminals: the workbench (if open) stays readable; no view switch
  }
  forgetCodexTab(id);
  saveCodexTabs();
}

export function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.body === "page") {
    // no pty behind a page tab: never kill_pty; the mount's teardown is the whole close
    s.pageDispose?.();
    s.pageDispose = undefined;
    removeSessionView(id, s);
    return;
  }
  if (s.body === "rendered") {
    // Closing a tab releases its view/controller. Local bodies implement detach
    // as a full stop; a hosted (Falcon) body ends the session the same as the
    // menu's Close Session — a detached session keeps the host alive forever
    // (idle exit needs no sessions and no clients), and a closed tab was never
    // a request to keep it hosted. Jettison (tab menu) is the only way to
    // leave a session hosted without a tab.
    const body = s.rendered;
    if (body) {
      if (body.hosted()) {
        void closeHostedTab(id);
        return;
      }
      void closeRenderedLocal(id); // view leaves now; detach and dispose settle off-DOM
      return;
    }
  } else {
    // The view leaves now; the kill settles off the UI thread and a failure
    // (tree still running) is logged rather than lost.
    invoke("kill_pty", { id, close: true }).catch((e: unknown) => console.error(`kill_pty ${id} failed: ${String(e)}`));
    detachTerminalBody(s);
  }
  removeSessionView(id, s);
}
