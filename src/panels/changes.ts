// Changes bench tab: git status of the focused tab's folder, with stage, unstage, Revert All, commit,
// sync and branch rename. Status refreshes on show, on `vidar-focus` while shown (those coalesce to one
// read per task), after each action and on a 5 s poll that runs only while the tab is on screen and the
// window is in front; a skipped tick is made up when the window returns. Every action captures the repo root
// at click time and never re-reads focus while it runs. Model: changes/model.ts; DOM:
// changes/view.ts; IPC: changes/actions.ts. The head switch picks git or Perforce (`changes.backend`);
// in p4 mode the same poll reads `changes_p4_status` and the list is read-only.
import { getFocusedSession } from "./sessions/lookup";
import { groupFiles, revertablePaths, type Groups } from "../changes/model";
import { act, commit, errText, readP4Status, readStatus, renameBranch, syncRepo, type ActVerb, type SyncMode } from "../changes/actions";
import { gitInitPrompt } from "../changes/git-prompt";
import { getPref, setPref } from "../prefs";
import { writeToSession } from "./sessions";
import { buildView, type Backend, type Busy, type View, type ViewState } from "../changes/view";

const POLL_MS = 5000;
const NO_GROUPS: Groups = { staged: [], changes: [] };

let view: View | undefined;
let visible = false;
let poll: ReturnType<typeof setInterval> | undefined;
let focusListener: (() => void) | undefined;
/** Window focus and visibility listeners, aborted on dispose. */
let awayOff: AbortController | undefined;
/** A poll tick was skipped while the window was away; the next return refreshes. */
let missed = false;
let refreshQueued = false;
let seq = 0;
let reading = false;
/** The Revert All list the open confirm was shown with; null when no confirm is open. */
let confirmPaths: string[] | null = null;
let state: ViewState = blank("");

function blank(cwd: string): ViewState {
  const backend: Backend = getPref("changes.backend") === "p4" ? "p4" : "git";
  return { mode: "loading", backend, p4: null, cwd, status: null, groups: NO_GROUPS, revertable: [], busy: null, error: null, done: null, confirm: false, renaming: false, note: null };
}

function draw() {
  view?.render(state);
}

/** The root the user is looking at now; null outside a repo. */
function currentRoot(): string | null {
  return state.mode === "repo" && state.status ? state.status.root : null;
}

/** The window is in the background or minimised: the poll waits for it to come back. */
function paused(): boolean {
  return document.hidden || !document.hasFocus();
}

/** One refresh per task however many triggers fire in it (show, `vidar-focus` and a return can
 *  land together when a tab switch opens the panel). */
function requestRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    void refresh();
  });
}

async function refresh() {
  if (!view) return;
  missed = false;
  const cwd = getFocusedSession()?.cwd ?? "";
  if (cwd !== state.cwd) {
    // another folder: its errors, confirm and rename do not carry over; an action in flight keeps its lock
    view.closeMenu();
    state = { ...blank(cwd), busy: state.busy };
  }
  if (!cwd) { state = { ...state, mode: "no-folder", status: null, p4: null, groups: NO_GROUPS, revertable: [] }; draw(); return; }
  const mine = ++seq;
  reading = true;
  if (state.backend === "p4") {
    try {
      const p4 = await readP4Status(cwd);
      if (mine !== seq || cwd !== state.cwd) return;
      state = { ...state, mode: "p4", p4, status: null, groups: NO_GROUPS, revertable: [] };
    } catch (e) {
      if (mine !== seq || cwd !== state.cwd) return;
      state = { ...state, error: errText(e) };
    } finally {
      if (mine === seq) reading = false;
    }
    draw();
    return;
  }
  try {
    const st = await readStatus(cwd);
    if (mine !== seq || cwd !== state.cwd) return;
    if (!st.repo) {
      state = { ...state, mode: "no-repo", status: null, groups: NO_GROUPS, revertable: [], confirm: false, renaming: false };
    } else {
      const groups = groupFiles(st.files);
      const revertable = revertablePaths(st.files, groups.changes);
      const sameRoot = state.status?.root === st.root;
      // a confirm covers the list it was opened on: any change to the list closes it (F2)
      const sameList = confirmPaths !== null && confirmPaths.length === revertable.length
        && confirmPaths.every((p, i) => p === revertable[i]);
      state = {
        ...state, mode: "repo", status: st, note: null, groups, revertable,
        confirm: state.confirm && sameRoot && sameList && revertable.length > 0,
        renaming: state.renaming && sameRoot && !st.detached,
        done: sameRoot ? state.done : null,
      };
    }
  } catch (e) {
    if (mine !== seq || cwd !== state.cwd) return;
    state = { ...state, error: errText(e) };
  } finally {
    if (mine === seq) reading = false;
  }
  draw();
}

/** Runs one action against the root captured now, holds every control until it settles, then
 *  re-reads status. Returns the action's value, or undefined when it failed (the error is held). */
async function run<T>(busy: Exclude<Busy, null>, job: (root: string) => Promise<T>): Promise<T | undefined> {
  const root = currentRoot();
  if (!root || state.busy) return undefined;
  view?.closeMenu();
  state = { ...state, busy, error: null, done: null };
  draw();
  let out: T | undefined;
  try {
    out = await job(root);
  } catch (e) {
    // the error belongs to the repo it ran in: dropped if the user has moved to another folder
    if (currentRoot() === root) state = { ...state, error: errText(e) };
  }
  state = { ...state, busy: null };
  await refresh();
  return out;
}

function onAct(verb: ActVerb, paths: string[]) {
  if (!paths.length) return;
  void run("act", (root) => act(root, verb, paths));
}

async function onCommit(sync: boolean) {
  const message = view?.message.value ?? "";
  if (!message.trim() || !state.groups.staged.length) return;
  const root = currentRoot();
  const res = await run(sync ? "commit-sync" : "commit", (r) => commit(r, message, sync));
  if (!res || currentRoot() !== root) return;
  if (view && view.message.value === message) view.message.value = "";
  // hook stderr shows only on failure (the rejected invoke's text); a landed commit shows its sha
  state = { ...state, done: { sha: res.sha, warning: res.warning }, error: res.syncError };
  draw();
}

/** The Git / Perforce switch: saves the pick, drops everything the other side drew and reads at once. */
function onBackend(b: Backend) {
  if (b === state.backend) return;
  if (!setPref("changes.backend", b)) return;
  view?.closeMenu();
  confirmPaths = null;
  state = { ...blank(state.cwd), busy: state.busy };
  reading = false; // a read the flip outdated never reaches its own reset
  draw();
  void refresh();
}

function onSync(mode: SyncMode) {
  void run("sync", (root) => syncRepo(root, mode));
}

async function onRename(name: string) {
  const want = name.trim();
  if (!want || want === state.status?.branch) { state = { ...state, renaming: false }; draw(); return; }
  const root = currentRoot();
  let ok = false;
  await run("rename", async (r) => { await renameBranch(r, want); ok = true; });
  if (ok && currentRoot() === root) { state = { ...state, renaming: false }; draw(); }
}

/** Types the git-setup prompt into the focused tab (the one whose folder is shown) without sending it. */
async function onGitPrompt() {
  const id = getFocusedSession()?.id ?? null; // captured before any await
  const cwd = state.cwd;
  const ok = id ? await writeToSession(id, gitInitPrompt(cwd)) : false;
  if (state.mode !== "no-repo" || state.cwd !== cwd) return;
  state = { ...state, note: ok ? null : "No tab to type into." }; // note-ok: src/panels/changes.ts
  draw();
}

function startPoll() {
  if (poll !== undefined) return;
  poll = setInterval(() => {
    if (!visible || state.busy || reading) return;
    if (paused()) { missed = true; return; }
    void refresh();
  }, POLL_MS);
}

function stopPoll() {
  if (poll !== undefined) clearInterval(poll);
  poll = undefined;
}

export function mountChangesView(parent: HTMLElement): HTMLElement {
  state = blank("");
  confirmPaths = null;
  visible = false;
  reading = false;
  view = buildView({
    stage: (paths) => onAct("stage", paths),
    unstage: (paths) => onAct("unstage", paths),
    revertAsk: () => { confirmPaths = [...state.revertable]; state = { ...state, confirm: true }; draw(); },
    revertCancel: () => { confirmPaths = null; state = { ...state, confirm: false }; draw(); },
    revertConfirm: () => {
      // the list the user was shown, never a newer poll's
      const paths = confirmPaths ?? [];
      confirmPaths = null;
      state = { ...state, confirm: false };
      onAct("revert", paths);
    },
    sync: onSync,
    commit: (sync) => void onCommit(sync),
    renameStart: () => { state = { ...state, renaming: true }; draw(); },
    renameCommit: (name) => void onRename(name),
    renameCancel: () => { state = { ...state, renaming: false }; draw(); },
    dismiss: () => { state = { ...state, error: null, done: null }; draw(); },
    gitPrompt: () => void onGitPrompt(),
    backend: onBackend,
  });
  parent.appendChild(view.root);
  focusListener = () => {
    if (visible) requestRefresh();
  };
  document.addEventListener("vidar-focus", focusListener);
  awayOff?.abort();
  awayOff = new AbortController();
  const back = () => {
    if (visible && missed && !paused()) requestRefresh();
  };
  window.addEventListener("focus", back, { signal: awayOff.signal });
  document.addEventListener("visibilitychange", back, { signal: awayOff.signal });
  return view.root;
}

export function onChangesShown() {
  visible = true;
  requestRefresh();
  startPoll();
}

export function onChangesHidden() {
  visible = false;
  stopPoll();
  view?.closeMenu();
}

export function disposeChangesView() {
  onChangesHidden();
  seq++;
  if (focusListener) document.removeEventListener("vidar-focus", focusListener);
  focusListener = undefined;
  awayOff?.abort();
  awayOff = undefined;
  missed = false;
  view?.root.remove();
  view = undefined;
  state = blank("");
}
