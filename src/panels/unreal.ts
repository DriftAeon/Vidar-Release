// Unreal bench tab: the focused folder's status, refreshed only while the tab is visible.
import { depFound, onDepsChange } from "../deps/state";
import { invoke, type UnrealDiag, type UnrealStatus } from "../ipc";
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
}

function startPoll() {
  stopPoll();
  poll = setInterval(() => {
    if (visible && !reading) void refresh();
  }, POLL_MS);
}

function stopPoll() {
  if (poll !== undefined) clearInterval(poll);
  poll = undefined;
}

export function mountUnrealView(parent: HTMLElement): HTMLElement {
  cwd = "";
  status = null;
  error = null;
  visible = false;
  reading = false;
  view = buildView({
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
  focusListener = () => { if (visible) void refresh(); };
  document.addEventListener("vidar-focus", focusListener);
  unsubscribeDeps = onDepsChange(() => { if (visible) draw(); });
  return view.root;
}

export function onUnrealShown() {
  visible = true;
  void refresh();
  startPoll();
}

export function onUnrealHidden() {
  visible = false;
  seq++;
  reading = false;
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
