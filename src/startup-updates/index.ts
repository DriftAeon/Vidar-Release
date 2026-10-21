// Nonmodal startup offers; the caller starts this before session initialization,
// without awaiting it. Backend checks and this UI each have an offline deadline.
import { invoke } from "../ipc";
import { renderStartupUpdateRows } from "../settings/dependencies-view";
import { explicitCheck, offeredUpdates, quietCheck, skippedVersions } from "./core";
import type { CliUpdate, CliUpdateBusy } from "./core";
import { driveSnapshot } from "../panels/sessions/lookup";
import { showSessionsToast } from "../panels/sessions/zoom";
import { warnCodexSkew } from "./codex-skew";
import { publishUpdates, setUpdateActor } from "./known";

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
  }, 12_000).then((updates) => { if (updates?.length) mount(updates); });
  void quietCheck(() => warnCodexSkew({
    check: () => invoke("codex_skew"),
    readState: () => invoke("read_state"),
    patch: (entries) => invoke("patch_state", { entries }),
    toast: (text) => showSessionsToast(text, 6000),
  }), 12_000);
}

/** Settings › Dependencies › Check for Updates: re-runs the backend check fresh and shows every newer
 *  offer, skipped versions too, in a new card that replaces any mounted one. Resolves with the count;
 *  rejects with the reason on error or "Check Timed Out". */
export async function checkUpdatesNow(): Promise<number> {
  const updates = await explicitCheck(() => invoke("check_cli_updates", { fresh: true }));
  if (updates.length) mount(updates);
  return updates.length;
}

let card: HTMLElement | null = null;
function mount(initial: CliUpdate[]): void {
  card?.remove();
  const root = document.createElement("aside");
  card = root;
  root.className = "startup-updates vs-confirm";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "CLI Updates");
  root.setAttribute("aria-live", "polite");
  document.body.appendChild(root);
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
      if (card === root) { card = null; setUpdateActor(null); }
      publish();
    }
  };
  async function act(u: CliUpdate, skip: boolean): Promise<void> {
    if (busy) return;
    busy = { id: u.id, label: skip ? "Saving…" : "Updating…" };
    error = null;
    paint();
    try {
      if (skip) await invoke("patch_state", { entries: { [`startupUpdates.skip.${u.id}`]: u.latest } });
      else await invoke("update_cli", { id: u.id, version: u.latest });
      remove(u.id);
    } catch (e) {
      busy = null;
      // The backend's own reason first; the generic line only when it gave none.
      error = String(e ?? "") || (skip ? "Skip Could Not Be Saved" : "Update Failed — Try Again or Use Dependencies");
      paint();
    }
  }
  setUpdateActor((u, skip) => {
    if (busy) return "Another Update Is Running";
    if (!skip && liveTabs(u)) return `Close ${u.label} Tabs First`;
    void act(u, skip);
    return null;
  });
  function paint(): void {
    publish();
    renderStartupUpdateRows(root, updates, busy, error, {
      update: (u) => { if (!liveTabs(u)) void act(u, false); },
      skip: (u) => { void act(u, true); },
      blocked: (u) => liveTabs(u) ? `Close ${u.label} Tabs First` : null,
    });
  }
  // Tabs open and close while the card waits: re-read them when the pointer reaches the card, so
  // the block lifts once the last tab of that CLI is closed.
  root.addEventListener("pointerenter", () => { if (!busy) paint(); });
  paint();
}
