// Unreal bench tab: the focused folder's status, refreshed only while the tab is visible.
import { depFound, onDepsChange } from "../deps/state";
import { invoke, type UnrealDiag, type UnrealEnginePin, type UnrealMcpPills, type UnrealStatus } from "../ipc";
import { pickFolder } from "../launcher/workspaces";
import { getPref, setPref } from "../prefs";
import {
  currentDismissed, dismissDiag, dismissDiags, groupDiags, sendTarget, sendText, storeDismissed, withoutDismissed,
  type DismissedEntry,
} from "../unreal/model";
import { lastToucher } from "../unreal/touched";
import { buildView, type View } from "../unreal/view";
import { getFocusedSession, sessionContainer, sessionKind, sessionTitle } from "./sessions/lookup";
import { writeToSession } from "./sessions";

const POLL_MS = 5000;
const MCP_POLL_MS = 30000; // unreal_mcp_status can take ~7.5 s: its own timer and guard, never the log poll

let view: View | undefined;
let visible = false;
let poll: ReturnType<typeof setInterval> | undefined;
let focusListener: (() => void) | undefined;
let unsubscribeDeps: (() => void) | undefined;
let seq = 0;
let reading = false;
let cwd = "";
let status: UnrealStatus | null = null;
let error: string | null = null;
let mcpPoll: ReturnType<typeof setInterval> | undefined;
let mcpSeq = 0;
let mcpReading = false;
let extrasRoot = "";
let mcp: UnrealMcpPills | null = null;
let pin: UnrealEnginePin | null = null;
let pinError: string | null = null;

function target(diag: UnrealDiag): { id: string; name: string } | null {
  const id = sendTarget(
    diag, lastToucher,
    (candidate) => sessionContainer(candidate) !== null && sessionKind(candidate)?.body !== "page",
    getFocusedSession()?.id ?? null,
  );
  return id ? { id, name: sessionTitle(id) ?? id } : null;
}

function dismissedFor(s: UnrealStatus): DismissedEntry {
  const root = s.project?.root;
  const stored = root ? getPref("unreal.dismissed")?.[root] : undefined;
  return currentDismissed(stored, s);
}

/** Clears a project's stored dismissals once its build or live-coding time has moved on. */
function syncDismissed(s: UnrealStatus) {
  const root = s.project?.root;
  if (!root) return;
  const map = getPref("unreal.dismissed");
  if (map?.[root] && dismissedFor(s) !== map[root]) setPref("unreal.dismissed", storeDismissed(map, root, dismissedFor(s)));
}

function draw() {
  const entry = status ? dismissedFor(status) : null;
  view?.render({
    mcp,
    pin,
    pinError,
    status,
    groups: status && entry ? groupDiags(withoutDismissed(status, entry)) : null,
    dismissed: entry?.keys ?? [],
    error,
    rider: depFound("rider") === true,
  });
}

async function refresh() {
  if (!view || !visible) return;
  const nextCwd = getFocusedSession()?.cwd ?? "";
  if (nextCwd !== cwd) {
    cwd = nextCwd;
    status = null;
    error = null;
    draw();
  }
  if (!nextCwd) return;
  const mine = ++seq;
  reading = true;
  try {
    const nextStatus = await invoke("unreal_status", { cwd: nextCwd });
    if (mine !== seq || nextCwd !== cwd || !visible) return;
    status = nextStatus;
    error = null;
    syncDismissed(nextStatus);
  } catch (e) {
    if (mine !== seq || nextCwd !== cwd || !visible) return;
    status = null;
    error = String(e);
  } finally {
    if (mine === seq) reading = false;
  }
  draw();
  if (status?.project && status.project.root !== extrasRoot) void refreshExtras();
}

/** The pin and the MCP pills for the shown project; own sequence and in-flight guard. */
async function refreshExtras() {
  const root = status?.project?.root;
  if (!view || !visible || !root) return;
  if (root !== extrasRoot) {
    extrasRoot = root;
    mcp = null;
    pin = null;
    pinError = null;
    mcpSeq++;
    mcpReading = false;
    draw();
  }
  void invoke("unreal_engine_pin", { root }).then((next) => {
    if (root !== extrasRoot || !visible) return;
    pin = next;
    draw();
  }).catch(console.error);
  if (mcpReading) return;
  const mine = ++mcpSeq;
  mcpReading = true;
  try {
    const next = await invoke("unreal_mcp_status", { root });
    if (mine !== mcpSeq || root !== extrasRoot || !visible) return;
    mcp = next;
    draw();
  } catch (e) {
    console.error(e);
  } finally {
    if (mine === mcpSeq) mcpReading = false;
  }
}

async function setPin(engine: string | null) {
  const root = status?.project?.root;
  if (!root) return;
  try {
    const next = await invoke("unreal_engine_pin_set", { root, engine });
    if (root !== extrasRoot) return;
    pin = next;
    pinError = null;
  } catch (e) {
    if (root !== extrasRoot) return;
    pinError = String(e);
  }
  draw();
}

async function pickPin() {
  const folder = await pickFolder(pin?.engine);
  if (folder) await setPin(folder);
}

function startPoll() {
  stopPoll();
  poll = setInterval(() => {
    if (visible && !reading) void refresh();
  }, POLL_MS);
  mcpPoll = setInterval(() => {
    if (visible && !mcpReading) void refreshExtras();
  }, MCP_POLL_MS);
}

function stopPoll() {
  if (poll !== undefined) clearInterval(poll);
  poll = undefined;
  if (mcpPoll !== undefined) clearInterval(mcpPoll);
  mcpPoll = undefined;
}

export function mountUnrealView(parent: HTMLElement): HTMLElement {
  cwd = "";
  status = null;
  error = null;
  visible = false;
  reading = false;
  mcpReading = false;
  mcpSeq++;
  extrasRoot = "";
  mcp = null;
  pin = null;
  pinError = null;
  view = buildView({
    pinChoices: () => invoke("unreal_engine_choices", undefined),
    pinSet: (engine) => { void setPin(engine); },
    pinPick: () => { void pickPin(); },
    target,
    send: (diag) => {
      const dest = target(diag);
      if (dest) void writeToSession(dest.id, sendText(diag));
    },
    dismiss: (diag) => {
      const root = status?.project?.root;
      if (!status || !root) return;
      const entry = dismissDiag(dismissedFor(status), diag);
      setPref("unreal.dismissed", storeDismissed(getPref("unreal.dismissed"), root, entry));
      draw();
    },
    dismissAll: (diags) => {
      const root = status?.project?.root;
      if (!status || !root) return;
      const entry = dismissDiags(dismissedFor(status), diags);
      setPref("unreal.dismissed", storeDismissed(getPref("unreal.dismissed"), root, entry));
      draw();
    },
    open: (diag) => {
      if (!diag.file || depFound("rider") !== true) return;
      void invoke("open_in_editor", { path: diag.file, line: diag.line ?? 1 }).catch(console.error);
    },
  });
  parent.appendChild(view.root);
  focusListener = () => { if (visible) { void refresh(); void refreshExtras(); } };
  document.addEventListener("vidar-focus", focusListener);
  unsubscribeDeps = onDepsChange(() => { if (visible) draw(); });
  return view.root;
}

export function onUnrealShown() {
  visible = true;
  void refresh();
  void refreshExtras();
  startPoll();
}

export function onUnrealHidden() {
  visible = false;
  seq++;
  reading = false;
  mcpSeq++;
  mcpReading = false;
  stopPoll();
}

export function disposeUnrealView() {
  onUnrealHidden();
  if (focusListener) document.removeEventListener("vidar-focus", focusListener);
  focusListener = undefined;
  unsubscribeDeps?.();
  unsubscribeDeps = undefined;
  view?.root.remove();
  view = undefined;
  cwd = "";
  status = null;
  error = null;
}
