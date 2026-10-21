// The live model and 5H/7D meters of the focused raw (terminal) Codex tab. Codex has no statusline
// hook and a raw tab's launcher `model` is only a label, so Rust reads both from the tab's rollout
// (`read_codex_limits`, status/codex.rs) and this hands them to the status flyout (`setCodexStatus`),
// which also dispatches the character status. Rendered Codex tabs report their own model
// (rendered-body.ts) and are skipped.
import { invoke } from "../ipc";
import { setCodexStatus } from "./status";
import { getFocusedSession, sessionKind, type FocusedSession } from "./sessions";

// Rollout turn records land at turn start; a /model change shows with the next turn anyway.
const POLL_MS = 15_000;

export function watchCodexModel(signal: AbortSignal): void {
  let target: FocusedSession | null = null;
  let timer: number | undefined;

  async function read(tab: FocusedSession): Promise<void> {
    if (document.hidden) return;
    const limits = await invoke("read_codex_limits", { cwd: tab.cwd, tab: tab.id, profile: tab.profile ?? null }).catch(() => null);
    // A focus change while the native call was in flight makes this stale.
    if (signal.aborted || !limits || target?.id !== tab.id) return;
    // status.ts renders the entry and is the one dispatcher of its character status.
    setCodexStatus(tab.id, limits);
  }

  function focus(next: FocusedSession | null): void {
    window.clearInterval(timer);
    timer = undefined;
    const raw = next?.agent === "codex" && next.cwd !== "" && sessionKind(next.id)?.body === "terminal";
    target = raw ? next : null;
    if (!target) return;
    const tab = target;
    void read(tab);
    timer = window.setInterval(() => void read(tab), POLL_MS);
  }

  document.addEventListener("vidar-focus", (event) => {
    focus((event as CustomEvent<FocusedSession | null>).detail);
  }, { signal });
  signal.addEventListener("abort", () => window.clearInterval(timer));
  focus(getFocusedSession());
}
