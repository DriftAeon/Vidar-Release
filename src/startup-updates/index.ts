// Nonmodal startup offers; the caller starts this before session initialization,
// without awaiting it. Backend checks and this UI each have an offline deadline.
import { invoke } from "../ipc";
import { renderStartupUpdateRows } from "../settings/dependencies-view";
import { explicitCheck, offeredUpdates, quietCheck, skippedVersions } from "./core";
import type { CliUpdate, CliUpdateBusy } from "./core";
import { iconImg } from "../icon-img";
import { updateAll } from "./batch";
import { cardShell } from "./shell";
import type { CardShell } from "./shell";
import { driveSnapshot } from "../panels/sessions/lookup";
import { showSessionsToast } from "../panels/sessions/zoom";
import { warnCodexSkew } from "./codex-skew";
import { publishUpdates, setUpdateActor } from "./known";
import { checkInput, launchCheckDue, releaseRows, statePatch } from "./release";
import type { ReleaseReply, ReleaseRow } from "./release";

/** The CLI check's offline deadline; the release check starts once it has passed. */
const CLI_DEADLINE_MS = 12_000;

/** True when an open tab runs this CLI. Tab agent kinds match update ids (claude, codex, gemini,
 *  pi); a gateway tab is agent "claude", so its art needs no separate match. */
function liveTabs(u: CliUpdate): boolean {
  return driveSnapshot().tabs.some((t) => t.agent === u.id);
}

let started = false;
export function startStartupUpdates(): void {
  if (started) return;
  started = true;
  void quietCheck(async () => {
    const [updates, state] = await Promise.all([invoke("check_cli_updates", { fresh: false }), invoke("read_state")]);
    return offeredUpdates(updates, skippedVersions(state));
  }, CLI_DEADLINE_MS).then((updates) => { if (updates?.length) mount(updates); });
  void quietCheck(() => warnCodexSkew({
    check: () => invoke("codex_skew"),
    readState: () => invoke("read_state"),
    patch: (entries) => invoke("patch_state", { entries }),
    toast: (text) => showSessionsToast(text, 6000),
  }), CLI_DEADLINE_MS);
  // Vidar and pack releases: after the CLI deadline, at most once per 24 h, silent on any failure.
  setTimeout(() => {
    void invoke("read_state").then((state) => {
      if (launchCheckDue(state, Date.now())) return runReleaseCheck(state);
    }).catch(() => {});
  }, CLI_DEADLINE_MS);
}

async function runReleaseCheck(state: Record<string, unknown>): Promise<ReleaseReply> {
  const reply = await invoke("check_release", checkInput(state));
  const entries = statePatch(reply, Date.now());
  if (Object.keys(entries).length) await invoke("patch_state", { entries }).catch(() => {});
  const rows = releaseRows(reply, state);
  if (rows.length) mountRelease(rows);
  return reply;
}

/** Settings › General › Check Now: runs whatever the launch toggle says and shows any offer in the
 *  card. Resolves with the reply; rejects only when the command itself fails. */
export async function checkReleaseNow(): Promise<ReleaseReply> {
  return runReleaseCheck(await invoke("read_state"));
}

/** Settings › Dependencies › Check for Updates: re-runs the backend check fresh and shows every newer
 *  offer, skipped versions too, in a new card that replaces any mounted one. Resolves with the count;
 *  rejects with the reason on error or "Check Timed Out". */
export async function checkUpdatesNow(): Promise<number> {
  const updates = await explicitCheck(() => invoke("check_cli_updates", { fresh: true }));
  if (updates.length) mount(updates);
  return updates.length;
}

// One fixed card holds both groups: CLI offers on top, Vidar and pack releases below. It leaves the
// page once both groups are gone.
let shell: CardShell | null = null;
let cliGroup: HTMLElement | null = null;
let releaseGroup: HTMLElement | null = null;

/** Close only hides the card (shell.ts): an update in flight is an `invoke` promise owned by `act`,
 *  not by the card, so it runs on and its failure surfaces as a toast. A new offer shows it again. */
function container(): HTMLElement {
  shell ??= cardShell(document, () => iconImg("close"));
  shell.show();
  return shell.body;
}
function settle(): void {
  if (!shell) return;
  if (!cliGroup && !releaseGroup) { shell.destroy(); shell = null; return; }
  shell.card.setAttribute("aria-label", cliGroup ? "CLI Updates" : "Update Available");
}

function mount(initial: CliUpdate[]): void {
  cliGroup?.remove();
  const root = document.createElement("div");
  cliGroup = root;
  container().prepend(root);
  settle();
  let updates = initial;
  let busy: CliUpdateBusy | null = null;
  let error: string | null = null;
  const publish = (): void => publishUpdates({ updates, busy, error });
  const remove = (id: string): void => {
    updates = updates.filter((u) => u.id !== id);
    busy = null;
    if (updates.length) paint();
    else {
      root.remove();
      if (cliGroup === root) { cliGroup = null; setUpdateActor(null); settle(); }
      publish();
    }
  };
  let batch = false;
  async function act(u: CliUpdate, skip: boolean): Promise<boolean> {
    if (busy) return false;
    busy = { id: u.id, label: skip ? "Saving…" : "Updating…" };
    error = null;
    paint();
    try {
      if (skip) await invoke("patch_state", { entries: { [`startupUpdates.skip.${u.id}`]: u.latest } });
      else await invoke("update_cli", { id: u.id, version: u.latest });
      remove(u.id);
      return true;
    } catch (e) {
      busy = null;
      // The backend's own reason first; the generic line only when it gave none.
      error = String(e ?? "") || (skip ? "Skip Could Not Be Saved" : "Update Failed — Try Again or Use Dependencies");
      paint();
      // The card may have been closed meanwhile; say so where the user is looking.
      if (shell?.card.hidden) showSessionsToast(`${u.label}: ${error}`, 6000);
      return false;
    }
  }
  async function runAll(): Promise<void> {
    if (busy || batch) return;
    batch = true;
    paint();
    try { await updateAll(updates, blockedBy, (u) => act(u, false)); }
    finally { batch = false; if (cliGroup === root) paint(); }
  }
  const blockedBy = (u: CliUpdate): string | null => liveTabs(u) ? `Close ${u.label} Tabs First` : null;
  setUpdateActor((u, skip) => {
    if (busy || batch) return "Another Update Is Running";
    if (!skip && liveTabs(u)) return `Close ${u.label} Tabs First`;
    void act(u, skip);
    return null;
  });
  function paint(): void {
    publish();
    renderStartupUpdateRows(root, updates, busy, error, {
      update: (u) => { if (!liveTabs(u)) void act(u, false); },
      skip: (u) => { void act(u, true); },
      blocked: blockedBy,
      updateAll: () => { void runAll(); },
    }, undefined, batch);
  }
  // Tabs open and close while the card waits: re-read them when the pointer reaches the card, so
  // the block lifts once the last tab of that CLI is closed.
  root.addEventListener("pointerenter", () => { if (!busy) paint(); });
  paint();
}

/** The release group: one row per offer, Open Release opens its page, Skip records the version. */
function mountRelease(initial: ReleaseRow[]): void {
  releaseGroup?.remove();
  const root = document.createElement("div");
  releaseGroup = root;
  container().appendChild(root);
  settle();
  let rows = initial;
  let busy: CliUpdateBusy | null = null;
  let error: string | null = null;
  const byId = (u: CliUpdate): ReleaseRow | undefined => rows.find((r) => r.id === u.id);
  async function skip(u: CliUpdate): Promise<void> {
    const row = byId(u);
    if (busy || !row) return;
    busy = { id: row.id, label: "Saving…" };
    error = null;
    paint();
    try {
      await invoke("patch_state", { entries: { [row.skipKey]: row.latest } });
      busy = null;
      rows = rows.filter((r) => r.id !== row.id);
      if (rows.length) paint();
      else { root.remove(); if (releaseGroup === root) { releaseGroup = null; settle(); } }
    } catch (e) {
      busy = null;
      error = String(e ?? "") || "Skip Could Not Be Saved";
      paint();
    }
  }
  function paint(): void {
    renderStartupUpdateRows(root, rows, busy, error, {
      update: (u) => { const row = byId(u); if (row?.page) void invoke("open_url", { url: row.page }); },
      skip: (u) => { void skip(u); },
      blocked: (u) => byId(u)?.blocked ?? null,
    }, { heading: "Update Available", main: "Open Release" });
    // A row with no page (the index named none this build may open) has nothing to open.
    for (const r of rows) {
      if (r.page) continue;
      root.querySelectorAll<HTMLElement>(".deps-row").forEach((el) => {
        if (el.dataset.cli === r.id) el.querySelector<HTMLButtonElement>(".deps-update")?.setAttribute("disabled", "");
      });
    }
  }
  paint();
}
